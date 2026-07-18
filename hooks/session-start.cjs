'use strict';
// SessionStart hook. Does NO blocking network work, so session start is always
// fast (sub-second) even if the gateway is slow or down — important when this
// ships to many machines. Three jobs, all best-effort, always exits 0:
//   1. Emit guidance/bifrost-context.md (how to reach the gateway; code-mode).
//   2. Emit a skill-library primer + a recalled-memory header, both read from a
//      per-project cache (instant). First session has no cache → those sections
//      are omitted but the cache gets seeded for next time.
//   3. If the cache is missing or stale, spawn a detached background worker
//      (refresh.cjs) that talks to the gateway and refreshes it. It outlives
//      this hook and never delays startup. The query it sends contains only the
//      project directory basename plus a fixed recall phrase — nothing else
//      leaves the machine. Disable all background refresh (and thereby all
//      session-start-initiated network traffic) with BIFROST_REFRESH=0.
//
// This hook only reads/writes its own cache under ~/.cache/bifrost-plugin/.
// It never launches other programs, opens browsers, or touches Claude Code
// configuration — onboarding is exclusively the explicit /bifrost-setup command.
//
// Disable memory/skills/kb headers with BIFROST_MEMORY_INJECT=0 /
// BIFROST_SKILLS_INJECT=0 / BIFROST_KB_INJECT=0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const gw = require('./lib/gateway.cjs');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function emitContext() {
  try {
    process.stdout.write(fs.readFileSync(path.join(__dirname, '..', 'guidance', 'bifrost-context.md'), 'utf8'));
  } catch (_) {}
}

function projectName() {
  const dir = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  return dir ? path.basename(dir) : '';
}

function projectQuery() {
  const n = projectName();
  const base = 'recent decisions, gotchas, conventions, open work';
  return n ? `${n} ${base}` : base;
}

function cacheFile() {
  const key = (projectName() || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(os.homedir(), '.cache', 'bifrost-plugin', `inject-${key}.json`);
}

function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c.at === 'number' && Date.now() - c.at < CACHE_TTL_MS) return c;
  } catch (_) {}
  return null;
}

function emitSkills(cache) {
  if (process.env.BIFROST_SKILLS_INJECT === '0') return;
  const s = cache && cache.skills;
  if (!s || !s.server) return;
  const call = s.mode === 'flat'
    ? (t) => `mcp__bifrost__${s.server}-${t}`
    : (t) => `executeToolCode → ${s.server}.${t}(...)`;
  const lines = [
    '',
    '## Bifrost skill library — discover before you build',
    '',
    'Before non-trivial work (implement, debug, deploy, review, infra, tests), search',
    'the skill library — a match may handle the task or give a specialized procedure.',
    '',
    `- **Search**: \`${call('skill_search')}\` with \`query="<task>"\`.`,
    `- **Browse**: \`${call('skill_navigate')}\` with \`node="<id>"\` (omit for root).`,
    `- **Load**: \`${call('get_skill')}\` with \`name="<skill>"\`.`,
    '',
  ];
  if (Array.isArray(s.branches) && s.branches.length) {
    lines.push('Sample domains:');
    for (const b of s.branches) lines.push(`  ${b}`);
    lines.push('');
  }
  process.stdout.write(lines.join('\n'));
}

// Facts are either plain strings (older caches, pre-adaptive-sizing refresh.cjs)
// or {content, similarity} objects (current refresh.cjs). Handle both so a
// stale cache from a not-yet-refreshed install never breaks the header.
function factText(f) {
  if (typeof f === 'string') return f;
  return (f && typeof f.content === 'string') ? f.content : '';
}

function emitMemory(cache) {
  if (process.env.BIFROST_MEMORY_INJECT === '0') return;
  const m = cache && cache.memory;
  const facts = m && Array.isArray(m.facts) ? m.facts : [];
  if (!facts.length) return;
  const lines = ['', '## Bifrost memory — recalled for this project', ''];
  for (const f of facts) {
    const t = factText(f);
    if (t) lines.push(`- ${t}`);
  }
  lines.push('');
  lines.push(
    '_Cached recall (refreshing in the background). Search the memory server for ' +
      'specifics; store durable facts after significant work._'
  );
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

function emitKb(cache) {
  if (process.env.BIFROST_KB_INJECT === '0') return;
  const k = cache && cache.kb;
  const facts = k && Array.isArray(k.facts) ? k.facts : [];
  if (!facts.length) return;
  const lines = ['', '## Bifrost knowledgebase — recalled for this project', ''];
  for (const f of facts) {
    const t = factText(f);
    if (t) lines.push(`- ${t}`);
  }
  lines.push('');
  lines.push(
    '_Cached recall (refreshing in the background). Search the memory server ' +
      '(KB wing) for specifics._'
  );
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

// How often the background refresh may re-contact the gateway. Independent of
// CACHE_TTL_MS (how long cached content is considered emittable) so recall
// stays warm without a network round-trip on every single session start.
const REFRESH_INTERVAL_MS = parseInt(
  process.env.BIFROST_REFRESH_INTERVAL_MS || String(60 * 60 * 1000), 10);

// Fire-and-forget background refresh — detached + unref so it never blocks.
// Skipped entirely with BIFROST_REFRESH=0 (master kill switch: no session-start
// network traffic of any kind), and skipped while the cache file is younger
// than REFRESH_INTERVAL_MS so session starts don't beacon the gateway.
function spawnRefresh(file) {
  if (process.env.BIFROST_REFRESH === '0') return;
  const { url, vk } = gw.env();
  if (!url || !vk) return;
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < REFRESH_INTERVAL_MS) return;
  } catch (_) { /* no cache yet — refresh */ }
  try {
    spawn(
      process.execPath,
      [path.join(__dirname, 'refresh.cjs'), file, projectQuery()],
      { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }
    ).unref();
  } catch (_) {}
}

function main() {
  try {
    emitContext();
    const file = cacheFile();
    const cache = readCache(file);
    try { emitSkills(cache); } catch (_) {}
    try { emitMemory(cache); } catch (_) {}
    try { emitKb(cache); } catch (_) {}
    spawnRefresh(file);
  } catch (_) { /* silent-fail — never block session start */ }
  process.exit(0);
}

main();
