'use strict';
// SessionStart hook. Does NO blocking network work, so session start is always
// fast (sub-second) even if the gateway is slow or down — important when this
// ships to many machines. Three jobs, all best-effort, always exits 0:
//   1. Emit guidance/bifrost-context.md (how to reach the gateway; code-mode).
//   2. Emit a skill-library primer + a recalled-memory header, both read from a
//      per-project cache (instant). First session has no cache → those sections
//      are omitted but the cache gets seeded for next time.
//   3. Spawn a detached background worker (refresh.cjs) that talks to the gateway
//      and refreshes the cache. It outlives this hook and never delays startup.
//
// Disable memory/skills headers with BIFROST_MEMORY_INJECT=0 / BIFROST_SKILLS_INJECT=0.

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

function emitMemory(cache) {
  if (process.env.BIFROST_MEMORY_INJECT === '0') return;
  const m = cache && cache.memory;
  const facts = m && Array.isArray(m.facts) ? m.facts : [];
  if (!facts.length) return;
  const lines = ['', '## Bifrost memory — recalled for this project', ''];
  for (const f of facts) lines.push(`- ${f}`);
  lines.push('');
  lines.push(
    '_Cached recall (refreshing in the background). Search the memory server for ' +
      'specifics; store durable facts after significant work._'
  );
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

// Fire-and-forget background refresh — detached + unref so it never blocks.
function spawnRefresh(file) {
  const { url, vk } = gw.env();
  if (!url || !vk) return;
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
    spawnRefresh(file);
  } catch (_) { /* silent-fail — never block session start */ }
  process.exit(0);
}

main();
