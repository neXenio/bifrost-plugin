'use strict';
// SessionStart hook. Two jobs, both best-effort, always exits 0:
//   1. Emit guidance/bifrost-context.md so the agent knows how to reach the
//      gateway (skills, memory, code-mode).
//   2. HYBRID memory: if a gateway + key are configured, recall a few salient
//      memories for this project and inject them as a compact header, so the
//      agent starts with context instead of having to remember to pull it.
//      Agent-driven memory_search/memory_store (PULL) still applies for the
//      rest of the session — this just primes the first turn.
//
// Disable the memory header with BIFROST_MEMORY_INJECT=0. Never blocks or
// delays session start beyond a short timeout; any failure is silent.

const fs = require('fs');
const path = require('path');
const gw = require('./lib/gateway.cjs');

const MEM_TIMEOUT_MS = 3500;
const MAX_FACTS = 6;
const SNIPPET_LEN = 180;

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

// The gateway echoes memory hits as JSON; pull out the "content" strings without
// depending on the exact envelope (flat return vs code-mode [TOOL] log line).
function extractFacts(text) {
  if (!text) return [];
  const facts = [];
  const re = /"content"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(text)) && facts.length < MAX_FACTS) {
    let s;
    try { s = JSON.parse(m[1]); } catch (_) { continue; }
    s = s.replace(/\s+/g, ' ').trim();
    if (s) facts.push(s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN) + '…' : s);
  }
  return facts;
}

async function emitMemory() {
  if (process.env.BIFROST_MEMORY_INJECT === '0') return;
  const { url, vk } = gw.env();
  if (!url || !vk) return; // not configured — nothing to recall

  const caps = await gw.getCapabilities(MEM_TIMEOUT_MS);
  if (!caps || !caps.memory) return; // gateway exposes no memory server

  const text = await gw.callCapability(
    caps.memory,
    'memory_search',
    { query: projectQuery(), k: MAX_FACTS },
    MEM_TIMEOUT_MS
  );
  const facts = extractFacts(text);
  if (!facts.length) return;

  const lines = ['', '## Bifrost memory — recalled for this project', ''];
  for (const f of facts) lines.push(`- ${f}`);
  lines.push('');
  lines.push(
    `_Pulled via ${caps.memory.server}.memory_search (${caps.memory.mode}). ` +
      'Search again for specifics; store durable facts after significant work._'
  );
  lines.push('');
  process.stdout.write(lines.join('\n'));
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
  try { await emitMemory(); } catch (_) { /* silent */ }
  process.exit(0);
}

main().catch(() => process.exit(0));
