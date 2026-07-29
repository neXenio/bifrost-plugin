'use strict';
// UserPromptSubmit hook — skill-discovery nudge. When the prompt contains a real
// task verb, emit a hint to search the gateway's skill library before starting.
//
// The exact invocation depends on how this gateway exposes the skills server
// (flat mcp__bifrost__<server>-skill_search vs code-mode executeToolCode). That
// is resolved once by the SessionStart hook and cached; here we only READ the
// cache — never the network — so prompt submission is never delayed. Suppressed
// when BIFROST_VK is unset. Silent-fail; always exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const gw = require('./lib/gateway.cjs');

// The original 13 verbs missed exactly the prompts where a specialized procedure pays
// off most — "why is p95 up", "the webhook 500s", "investigate this", "audit the
// config", "port X to Y" all failed to match. With a 1,000+ skill library a false
// negative costs far more than a false positive, so this leans inclusive.
const TASK_VERB_RE = new RegExp(
  '\\b(' + [
    'fix', 'test', 'build', 'create', 'implement', 'debug', 'deploy', 'migrate',
    'review', 'refactor', 'integrate', 'scaffold', 'optimize',
    'investigate', 'analyz(?:e|se)', 'audit', 'harden', 'secure', 'trace',
    'diagnose', 'troubleshoot', 'upgrade', 'port', 'rename', 'document',
    'benchmark', 'profile', 'monitor', 'alert', 'automate', 'configure',
    'set\\s?up', 'roll\\s?out', 'write', 'add', 'remove', 'update',
    'why\\s+(?:is|are|does|did|do)', 'how\\s+(?:do|does|can|should)',
    'failing', 'broken', 'error', 'crash',
  ].join('|') + ')\\b',
  'i'
);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// Spell a skills-server call the way this gateway exposes it.
//
// Returns null when discovery has not run yet. Previously this guessed
// `mcp__bifrost__skills-skill_search`, which on a gateway whose skills server is
// code-mode or named anything else is a tool that does not exist — so the very first
// session, the one that sets the habit, taught the model a call that fails. Emitting
// nothing is strictly better than emitting a fabricated name.
function callFor(caps, toolFn, args) {
  if (!caps || !caps.skills) return null;
  if (caps.skills.mode === 'code') {
    const kv = args.map(([k, v]) => `${k}=${v}`).join(', ');
    return `\`executeToolCode\` with \`result = ${caps.skills.server}.${toolFn}(${kv})\``;
  }
  const named = args.map(([k, v]) => `\`${k}=${v}\``).join(', ');
  const tool = gw.flatToolName(caps.skills, toolFn);
  return named
    ? `\`mcp__bifrost__${tool}\` with ${named}`
    : `\`mcp__bifrost__${tool}\``;
}

// Check the team library first, but do not claim more for it than is true. An earlier
// version of this text called the contents "the team's validated procedures" — nobody
// validated a thousand skills, and the navigator's own labels are auto-generated. An
// injected overclaim is worse than no claim: it tells the model to defer to a bad
// match, and the one thing worse than not finding a skill is following the wrong one.
// So: look here first because it may hold something better and more current than a
// general approach, and judge what comes back on its merits.
//
// Search is primary; navigate is the fallback because the tree runs four levels deep
// with auto-generated labels, so it is worth trying only when a search phrased in the
// user's own words misses.
//
// Emitted in full the first time, then tapered to one line for the rest of the
// session. The full form is ~146 tokens; on a working session that matches thirty
// prompts, repeating it costs ~4,400 tokens of byte-identical text — more than the
// entire SessionStart block — and buys nothing after the first read. Worse, an
// unchanging directive repeated every turn competes for attention with context the
// model has not seen before, so the repetition works against the instruction it is
// trying to reinforce. The short form keeps the rule present on every prompt at about
// a quarter of the cost.
function nudge(caps, snippet, seenBefore) {
  const search = callFor(caps, 'skill_search', [['query', `"${snippet}"`], ['k', '5']]);
  if (!search) return null;

  if (seenBefore) {
    return `> **Check the skill library first** — ${search}, then judge the match.\n`;
  }

  const navigate = callFor(caps, 'skill_navigate', []);
  const load = callFor(caps, 'get_skill', [['name', '"<skill>"']]);
  return [
    '> **Check the Bifrost skill library before doing this yourself.** It may already',
    '> hold a team procedure for this, more current than a general approach.',
    '>',
    `> 1. Search: ${search}`,
    `> 2. If that misses, browse: ${navigate}`,
    `> 3. Load any match: ${load}, then judge it on its merits before following it.`,
    '>',
    '> Search first, then decide. A weak or stale match is not better than your own',
    '> approach — say so and proceed rather than forcing a poor fit.',
    '',
  ].join('\n');
}

// Has this session already seen the long form? Kept next to the Stop hook's markers,
// keyed on session id, and best-effort: if the marker cannot be written we emit the
// long form again rather than dropping the instruction.
const SEEN_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin', 'reflect');

function alreadyNudged(sessionId) {
  if (!sessionId) return false;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const file = path.join(SEEN_DIR, `${safe}.nudged`);
  try {
    if (fs.existsSync(file)) return true;
    fs.mkdirSync(SEEN_DIR, { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
  } catch (_) { return false; }
  return false;
}

// See session-start.cjs: stdout to a pipe is async on Windows and exit() does not
// drain it.
function exitWhenFlushed() {
  try {
    if (process.stdout.writableLength === 0) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  } catch (_) { process.exit(0); }
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch (_) { /* silent */ }
  const promptText = (event.prompt || event.user_prompt || event.message || '').trim();

  try {
    const { vk } = gw.env();
    if (vk && promptText && TASK_VERB_RE.test(promptText)) {
      const snippet = promptText.slice(0, 120).replace(/\n+/g, ' ').trim();
      const caps = await gw.getCapabilities(0, { cacheOnly: true });
      const text = nudge(caps, snippet, alreadyNudged(event.session_id));
      if (text) process.stdout.write(text);
    }
  } catch (_) { /* silent-fail */ }

  exitWhenFlushed();
}

main().catch(() => process.exit(0));
