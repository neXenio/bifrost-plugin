'use strict';
// SessionStart hook. Two jobs, both best-effort, always exits 0:
//   1. Emit guidance/bifrost-context.md so the agent knows how to reach the
//      gateway (skills, memory, code-mode).
//   2. HYBRID memory: inject a CACHED recall for this project instantly, and
//      kick off a detached background refresh for next time. Reading the cache
//      is sub-millisecond, so session start never waits on the memory backend
//      (which can be slow under concurrent load). Agent-driven
//      memory_search/memory_store (PULL) still applies for the rest of session.
//
// Disable the memory header with BIFROST_MEMORY_INJECT=0. Never blocks session
// start (cache read + detached spawn only); any failure is silent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const gw = require('./lib/gateway.cjs');

const MEM_TIMEOUT_MS = 3500;
const MEM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function emitContext() {
  try {
    const p = path.join(__dirname, '..', 'guidance', 'bifrost-context.md');
    process.stdout.write(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    // missing/unreadable — emit nothing, never block session start
  }
}

function projectQuery() {
  const dir = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  const name = dir ? path.basename(dir) : '';
  const base = 'recent decisions, gotchas, conventions, open work';
  return name ? `${name} ${base}` : base;
}

function memCacheFile() {
  const dir = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  const key = (dir ? path.basename(dir) : 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(os.homedir(), '.cache', 'bifrost-plugin', `memory-recall-${key}.json`);
}

// Inject a CACHED memory recall instantly, then kick off a detached background
// refresh for next time. Reading the cache is sub-millisecond, so session start
// never waits on the memory backend (which can be slow under concurrent load).
// First ever session for a project has no cache → no header, but the refresh
// populates it for the next one.
function emitMemory() {
  if (process.env.BIFROST_MEMORY_INJECT === '0') return;
  const { url, vk } = gw.env();
  if (!url || !vk) return; // not configured — nothing to recall

  const file = memCacheFile();

  // 1) Inject the cached recall immediately, if fresh.
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const facts = Array.isArray(c.facts) ? c.facts : [];
    const age = typeof c.at === 'number' ? Date.now() - c.at : Infinity;
    if (facts.length && age < MEM_CACHE_TTL_MS) {
      const lines = ['', '## Bifrost memory — recalled for this project', ''];
      for (const f of facts) lines.push(`- ${f}`);
      lines.push('');
      lines.push(
        '_Cached recall (refreshing in the background). Search the memory server ' +
          'for specifics; store durable facts after significant work._'
      );
      lines.push('');
      process.stdout.write(lines.join('\n'));
    }
  } catch (_) {
    // no cache yet — fine, the refresh below will create it
  }

  // 2) Fire-and-forget background refresh. Detached + unref so it outlives this
  //    hook and never delays session start, however slow the backend is.
  try {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'memory-refresh.cjs'), file, projectQuery()],
      { detached: true, stdio: 'ignore', env: process.env }
    );
    child.unref();
  } catch (_) {
    // spawn failed — silent; cache simply won't refresh this session
  }
}

// Skills primer: tell the agent the skill library exists, how to retrieve from
// it, and show a live sample of the navigator tree so the categories are
// concrete rather than abstract.
async function emitSkills() {
  if (process.env.BIFROST_SKILLS_INJECT === '0') return;
  const { url, vk } = gw.env();
  if (!url || !vk) return;

  const caps = await gw.getCapabilities(MEM_TIMEOUT_MS);
  if (!caps || !caps.skills) return;

  const s = caps.skills.server;
  const call = caps.skills.mode === 'flat'
    ? (t) => `mcp__bifrost__${s}-${t}`
    : (t) => `executeToolCode → ${s}.${t}(...)`;

  const lines = [
    '',
    '## Bifrost skill library — discover before you build',
    '',
    'A curated skill library is available through this gateway. Before non-trivial',
    'work (implement, debug, deploy, review, infra, tests), check it for a matching',
    'workflow — a skill may handle the task or give a specialized procedure.',
    '',
    `- **Search** by intent: \`${call('skill_search')}\` with \`query="<task>"\` (add \`k\` for more hits).`,
    `- **Browse** the decision tree: \`${call('skill_navigate')}\` with \`node="<id>"\` (omit \`node\` for the root).`,
    `- **Load** the full instructions: \`${call('get_skill')}\` with \`name="<skill>"\`.`,
    '',
  ];

  // Live sample of the navigator root so the domains are concrete.
  const tree = await gw.callCapability(caps.skills, 'skill_navigate', {}, MEM_TIMEOUT_MS);
  const branches = (tree || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /skill_navigate\(node=/.test(l))
    .slice(0, 10);
  if (branches.length) {
    lines.push('Sample domains (from the live navigator):');
    for (const b of branches) lines.push(`  ${b.replace(/^[•\-\*]\s*/, '')}`);
    lines.push('');
  }
  process.stdout.write(lines.join('\n'));
}

async function main() {
  emitContext();
  try { await emitSkills(); } catch (_) { /* silent */ }
  try { emitMemory(); } catch (_) { /* silent */ }
  process.exit(0);
}

main().catch(() => process.exit(0));
