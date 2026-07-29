'use strict';
// PostToolUse / PostToolUseFailure hook — the feedback signal.
//
// Everything else in this plugin pushes instructions at the model and assumes they
// land. Nothing observed whether they do. After a dozen changes nobody could answer
// whether `skill_search` was ever called, whether anything was ever recorded, or
// whether a single engineer's behaviour differed from before the plugin existed. A
// correct fix silently disabled the tool roster for weeks-worth of sessions and no
// mechanism would have surfaced it.
//
// This records, per session, which classes of gateway capability were used and
// whether the call succeeded. SessionStart then adapts what it injects: an agent
// already searching the skill library does not need to be told to, and one that never
// has needs a stronger prompt than a standing paragraph. That closes the loop the
// plugin has been asserting rather than measuring.
//
// WHAT IS RECORDED: the capability class (skills / memory / code), the bare tool name,
// and whether the call succeeded. Counts only.
// WHAT IS NEVER RECORDED: queries, arguments, results, file paths, prompts, or any
// content whatsoever. Nothing here leaves the machine — SessionStart reads the same
// local file. This is a behavioural counter, not telemetry.
//
// Registered async, so it never sits between a tool call and its result. Always
// exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Rolling window. Long enough to see a habit, short enough to notice one changing.
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function usageFile() {
  return path.join(os.homedir(), '.cache', 'bifrost-plugin', 'usage.json');
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

// Map a tool name to the capability it exercises. Deliberately coarse: the question
// is "did this session use the skill library at all", not which entry point.
function classify(toolName) {
  const n = String(toolName || '');
  if (!/^mcp__/.test(n)) return null;              // not a gateway tool
  if (/skill_search|skill_navigate|get_skill/.test(n)) return 'skills';
  if (/memory_search|memory_store|memory_call/.test(n)) return 'memory';
  if (/executeToolCode|listToolFiles|readToolFile|getToolDocs/.test(n)) return 'code';
  return null;
}

// `memory_store` is singled out because it is the only write in the whole system and
// the one behaviour the swarm goal depends on. Everything else is a read.
function isWrite(toolName) {
  return /memory_store/.test(String(toolName || ''));
}

function record(sessionId, toolName, ok, now = Date.now()) {
  const kind = classify(toolName);
  if (!kind || !sessionId) return null;

  const file = usageFile();
  let data = { version: 1, sessions: [] };
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) {}
  if (!Array.isArray(data.sessions)) data.sessions = [];

  data.sessions = data.sessions.filter((s) => s && now - s.at < SESSION_TTL_MS);

  let entry = data.sessions.find((s) => s.id === sessionId);
  if (!entry) {
    entry = { id: String(sessionId).slice(0, 80), at: now, skills: 0, memory: 0, code: 0, writes: 0, errors: 0 };
    data.sessions.push(entry);
  }
  entry.at = now;
  entry[kind] += 1;
  if (isWrite(toolName)) entry.writes += 1;
  if (!ok) entry.errors += 1;

  // Newest last, oldest dropped.
  data.sessions.sort((a, b) => a.at - b.at);
  if (data.sessions.length > MAX_SESSIONS) {
    data.sessions = data.sessions.slice(-MAX_SESSIONS);
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch (_) { return null; }
  return entry;
}

// Read-side summary, used by SessionStart to decide how hard to push.
// Excludes the session asking, so a session cannot judge itself by its own first turn.
function summary(excludeSessionId, now = Date.now()) {
  let data = { sessions: [] };
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(usageFile(), 'utf8'))); } catch (_) {}
  const rows = (Array.isArray(data.sessions) ? data.sessions : [])
    .filter((s) => s && now - s.at < SESSION_TTL_MS && s.id !== excludeSessionId);

  return {
    sessions: rows.length,
    skills: rows.filter((s) => s.skills > 0).length,
    memory: rows.filter((s) => s.memory > 0).length,
    code: rows.filter((s) => s.code > 0).length,
    writes: rows.filter((s) => s.writes > 0).length,
  };
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch (_) { /* silent */ }

  try {
    const tool = event.tool_name || (event.tool && event.tool.name) || '';
    // PostToolUseFailure carries the same shape; the event name distinguishes them.
    const ok = event.hook_event_name !== 'PostToolUseFailure';
    record(event.session_id, tool, ok);
  } catch (_) { /* silent-fail — a counter is never worth disturbing a tool call */ }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}

module.exports = { classify, isWrite, record, summary, usageFile, MAX_SESSIONS, SESSION_TTL_MS };
