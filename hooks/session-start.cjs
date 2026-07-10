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

const SETUP_RESULT = path.join(os.homedir(), '.cache', 'bifrost-plugin', 'auto-setup-result.json');
const SETUP_COOLDOWN_MS = parseInt(process.env.BIFROST_SETUP_COOLDOWN_MS || String(30 * 60 * 1000), 10);

function readSetupResult() {
  try { return JSON.parse(fs.readFileSync(SETUP_RESULT, 'utf8')); } catch (_) { return null; }
}

function writeSetupResult(obj) {
  try {
    fs.mkdirSync(path.dirname(SETUP_RESULT), { recursive: true });
    fs.writeFileSync(SETUP_RESULT, JSON.stringify({ at: Date.now(), ...obj }), 'utf8');
  } catch (_) {}
}

// Already connected? Legacy env users (BIFROST_VK set) and anyone the worker has
// already provisioned (marker ok) need nothing.
function isProvisioned(r) {
  if ((process.env.BIFROST_VK || '').trim()) return true;
  return !!(r && r.ok);
}

// First-run onboarding: when no key is configured, launch the detached browser flow
// (auto-setup.cjs). Transparent if the user holds a valid SSO cookie; on failure the
// worker leaves a marker and we surface a one-line warning next session. The browser
// is only re-opened once per cooldown so repeated failures don't spam tabs.
//
// This whole flow is opt-in per deployment: without BIFROST_KEYAPP_URL configured
// there is no generic keyapp to open, so we stay silent rather than nagging users
// on gateways that don't offer this onboarding path.
function maybeAutoSetup() {
  if (process.env.BIFROST_AUTOSETUP === '0') return;
  if (!(process.env.BIFROST_KEYAPP_URL || '').trim()) return;
  const r = readSetupResult();
  if (isProvisioned(r)) return;
  const last = r && typeof r.at === 'number' ? r.at : 0;
  if (Date.now() - last > SETUP_COOLDOWN_MS) {
    process.stdout.write('\n⚙️ Bifrost: opening your browser to connect access (transparent if you are signed in via SSO). Restart Claude Code once it completes; run `/bifrost-setup` to retry.\n');
    // Write the intent marker synchronously before spawning so a concurrent
    // session start within the cooldown window sees a fresh `at` and skips
    // spawning its own auto-setup worker.
    writeSetupResult({ ok: false, reason: 'in-progress' });
    try {
      spawn(process.execPath, [path.join(__dirname, 'auto-setup.cjs')],
        { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }).unref();
    } catch (_) {}
  } else if (r && !r.ok) {
    process.stdout.write(`\n⚠️ Bifrost access not connected yet (last attempt: ${r.reason || 'failed'}). Run \`/bifrost-setup\` to retry.\n`);
  }
}

// Dev-checkout self-heal: when this hook is running out of a git checkout
// (not a marketplace-installed cache dir), the installed plugin cache can go
// stale — Claude Code keeps loading the last-synced snapshot instead of the
// live checkout. If scripts/sync-plugin-cache.sh exists alongside this
// checkout, re-run it in the background so the next session picks up live
// edits without a manual reinstall. Best-effort, detached, silent-fail;
// disable with BIFROST_DEV_SYNC=0.
function maybeSelfHealDevCache() {
  if (process.env.BIFROST_DEV_SYNC === '0') return;
  const root = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(root, '.git'))) return; // only for dev checkouts
  const script = path.join(root, 'scripts', 'sync-plugin-cache.sh');
  if (!fs.existsSync(script)) return;
  try {
    spawn('bash', [script], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }).unref();
  } catch (_) {}
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
    try { maybeAutoSetup(); } catch (_) {}
    const file = cacheFile();
    const cache = readCache(file);
    try { emitSkills(cache); } catch (_) {}
    try { emitMemory(cache); } catch (_) {}
    try { emitKb(cache); } catch (_) {}
    spawnRefresh(file);
    try { maybeSelfHealDevCache(); } catch (_) {}
  } catch (_) { /* silent-fail — never block session start */ }
  process.exit(0);
}

main();
