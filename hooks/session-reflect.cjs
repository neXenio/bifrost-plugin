'use strict';
// Stop hook — the write half of the loop.
//
// Everything else in this plugin makes the gateway's skills, tools and memory easier
// to CONSUME. Nothing ever put anything back. `memory_store` exists as a flat tool on
// the gateway and, before this hook, no part of the plugin had ever called it or
// reminded anyone to. A corpus with many readers and no writers stops being memory and
// becomes a static file: it cannot record what this session learned, so the next
// engineer's agent rediscovers it from scratch.
//
// This hook does NOT write to memory itself. Deliberately: an extractor that stores
// every turn would add near-duplicate facts at machine speed to a corpus that already
// has ~75k relationships and zero SUPERSEDES edges, and a wrong fact repeated three
// times would outrank a correct one stated once. The agent is the only party here that
// knows whether something was actually learned, so the hook prompts and the agent
// judges — the same instruct-rather-than-do shape used for skill discovery.
//
// Safety rules for this event, in order of importance:
//   1. NEVER exit non-zero. Exit code 2 on Stop BLOCKS the turn from ending, which
//      would hang the user's session. Every path here exits 0.
//   2. Registered with "async": true, so Claude Code continues immediately and this
//      can never delay a response. Async `additionalContext` arrives on the next turn,
//      which is the right moment anyway.
//   3. Stop fires after EVERY assistant response. Without rate limiting this would be
//      spam, so it first asks once a session has run long enough to have learned
//      something, then periodically, and the later prompts are tapered to one line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const gw = require('./lib/gateway.cjs');

// Sessions shorter than this are answering a question, not doing work worth recording.
const MIN_TURNS_BEFORE_PROMPT = 3;
// After the first check-in, ask again every this many turns. Long sessions are where
// most is learned and where the most is forgotten: waiting for the end means the
// findings compete with whatever the session drifted into last, and a session that
// ends by running out of context never gets asked at all.
const PROMPT_INTERVAL_TURNS = 8;

// Resolved per call, not at require time. Module-level os.homedir() made these paths
// impossible to isolate: the test suite drove the real directory and deleted a live
// session's markers on the developer's own machine.
function stateDir() {
  return path.join(os.homedir(), '.cache', 'bifrost-plugin', 'reflect');
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// One marker per session id would otherwise accumulate forever in a directory nobody
// looks at. Sessions are done with their marker as soon as they end, so anything older
// than a couple of days is dead.
const MARKER_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function pruneMarkers(now) {
  try {
    const dir = stateDir();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > MARKER_TTL_MS) fs.unlinkSync(p);
      } catch (_) { /* raced with another session; fine */ }
    }
  } catch (_) { /* directory does not exist yet */ }
}

// Count turns per session and decide whether this firing should ask. Stop runs after
// EVERY response, so this fires once the session is long enough to have learned
// something and then periodically after that.
//
// Returns 0 for "stay quiet", or the check-in number (1, 2, 3, …) when it should ask,
// so the prompt can tell a first check-in from a later one.
function shouldPrompt(sessionId, now = Date.now()) {
  if (!sessionId) return 0;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const file = path.join(stateDir(), `${safe}.json`);
  let state = { turns: 0, prompts: 0 };
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) {}

  state.turns += 1;
  const since = state.turns - MIN_TURNS_BEFORE_PROMPT;
  const fire = since >= 0 && since % PROMPT_INTERVAL_TURNS === 0;
  if (fire) state.prompts += 1;

  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (_) { return 0; } // cannot rate-limit => do not prompt at all
  if (fire) pruneMarkers(now);
  return fire ? state.prompts : 0;
}

function call(cap, toolFn) {
  if (!cap) return null;
  if (cap.mode === 'code') return `result = ${cap.server}.${toolFn}(...)`;
  return `mcp__bifrost__${gw.flatToolName(cap, toolFn)}`;
}

// Candidates are written to a LOCAL spool, not to the shared corpus.
//
// The obvious design was `memory_store` with a `candidate` tag. It does not work:
// `memory_search` accepts query, k, tier, wing, room, agent_id, conversation_id,
// include_expired, detail and fast — and no tag, state or exclusion filter. A tagged
// entry is therefore returned by ordinary recall exactly like a reviewed fact, so the
// tag labels nothing for the reader and gates nothing. Calling that a "candidate"
// would have been a comforting name for an immediate company-wide write.
//
// That matters here more than it would elsewhere: the corpus carries ~75k
// relationships and zero SUPERSEDES edges, so nothing has ever been corrected once
// written, and 20 agents prompted to write every session would scale the write rate
// into a store with no demonstrated correction path.
//
// A local file is the one place a candidate is verifiably not recalled by anyone.
// Promotion into the shared corpus stays a deliberate human step.
// The spool lives in the PROJECT, not under ~/.cache. Two reasons, both load-bearing:
//
//   1. ~/.cache is regenerable-data by XDG convention. Cache cleaners delete it. The
//      only copy of unreviewed knowledge must not sit in the one directory designed
//      to be purged.
//   2. Writing outside the workspace raises a permission prompt under Claude Code's
//      default settings — the exact interruption this check-in tells the agent not to
//      cause. In-workspace, an append needs no prompt.
//
// `.bifrost/` gets a self-ignoring .gitignore on creation so candidates never reach a
// commit: these are unreviewed mid-session judgements, not repository content.
function candidateFile(projectDir) {
  const dir = (projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  return path.join(dir, '.bifrost', 'candidates.md');
}

// Create the spool (and its ignore rule) so the agent only ever has to append, and so
// "check the file first" does not mean "read a file that may not exist".
function ensureCandidateFile(projectDir) {
  const file = candidateFile(projectDir);
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file,
        '# Bifrost memory candidates\n\n'
        + 'Unreviewed findings recorded during sessions in this project. Local and\n'
        + 'git-ignored: nothing here is shared until someone promotes it.\n\n'
        + 'Review with `/bifrost-candidates`.\n\n', 'utf8');
    }
    return file;
  } catch (_) { return null; }
}

function reflection(caps, checkIn = 1, file = null) {
  const mem = caps && caps.memory;
  const store = call(mem, 'memory_store');
  if (!store) return null; // no memory server discovered — nothing actionable to say

  const spool = file || candidateFile();

  // Later check-ins taper, for the same reason the per-prompt nudge does: the criteria
  // list is ~500 tokens and byte-identical every time, so repeating it five times in a
  // long session costs more than the entire SessionStart block and adds nothing after
  // the first read. An unchanging directive also competes for attention with context
  // the model has not seen. The question is what needs repeating; the rubric is not.
  if (checkIn > 1) {
    return `**Memory check-in (${checkIn}).** Anything new worth appending to \`${spool}\`? `
      + 'Same criteria as before; "nothing" is a fine answer. Do not narrate this.';
  }

  return [
    '**MANDATORY Memory check-in.** Has anything worth remembering come out of this session so far?',
    '',
    'You MUST proactively use memory_store to add memories based on your current task and learnings.',
    'Do not wait for the user to ask you to remember. If you solved a problem, save the solution.',
    'Answer honestly, including "no" — most stretches of work produce nothing durable,',
    'and an empty answer is a good answer. Do not narrate this check to the user; just',
    'record anything that qualifies and carry on.',
    '',
    'Worth recording:',
    '',
    '- A decision and the reasoning behind it, especially one a future reader would',
    '  otherwise reverse without knowing why.',
    '- A root cause, and the symptom that led to it.',
    '- A convention, constraint or gotcha here that is not obvious from reading the code.',
    '- Something you found to be WRONG in the corpus or the docs. Corrections matter',
    '  more than additions.',
    '- A task you solved after the skill library came back with nothing useful — the',
    '  task and what you did. That is how a missing procedure becomes a skill.',
    '',
    'Not worth recording: transient state, per-file narration, anything already obvious',
    'from the code or git history, secrets or credentials, or a restatement of the task',
    'you were given.',
    '',
    `If something qualifies, append a bullet to \`${spool}\` (it already exists, and is`,
    'git-ignored). One self-contained claim per bullet, dated, written so it makes sense',
    'to someone who was not in this session. Skip anything already in the file.',
    '',
    `This is a local file, NOT \`${store}\`, and that is deliberate: shared memory here`,
    'has no review filter on reads, so anything written to it is recalled by every',
    'colleague immediately as settled team knowledge, with no correction path. Promotion',
    'is a separate step someone takes after reviewing the file (`/bifrost-candidates`).',
  ].join('\n');
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch (_) { /* silent */ }

  try {
    // Never re-enter: Claude Code sets this when a Stop hook's own continuation is
    // what produced the turn.
    if (event.stop_hook_active) return;

    const { vk } = gw.env();
    if (!vk) return;
    const checkIn = shouldPrompt(event.session_id);
    if (!checkIn) return;

    const caps = await gw.getCapabilities(0, { cacheOnly: true });
    // If the spool cannot be created (read-only checkout, permissions), stay silent
    // rather than instruct the agent to append to a path that provably does not work.
    const spool = ensureCandidateFile();
    if (!spool) return;
    const text = reflection(caps, checkIn, spool);
    if (!text) return;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text },
    }));
  } catch (_) { /* silent-fail — a reminder is never worth disrupting a session */ }
}

if (require.main === module) {
  // Exit 0 on every path, including a rejected promise: a non-zero exit here would
  // block the turn from ending.
  // Exit 0 on every path, including a rejected promise: a non-zero exit here would
  // block the turn from ending. Drain stdout first — see session-start.cjs.
  const done = () => {
    try {
      if (process.stdout.writableLength === 0) process.exit(0);
      process.stdout.once('drain', () => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    } catch (_) { process.exit(0); }
  };
  main().then(done).catch(done);
}

module.exports = {
  shouldPrompt,
  reflection,
  pruneMarkers,
  MIN_TURNS_BEFORE_PROMPT,
  PROMPT_INTERVAL_TURNS,
  MARKER_TTL_MS,
  stateDir,
  candidateFile,
  ensureCandidateFile,
};
