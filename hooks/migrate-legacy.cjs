'use strict';
// Opt-in cleanup of setups that predate the plugin, run detached by session-start.cjs
// at most once a day when the `migrate_legacy` option is on (off in the public plugin).
//
//   A hand-registered `bifrost` MCP server (`claude mcp add`, the key page, the old
//       installer) at the plugin's gateway URL. Claude Code drops a plugin server whose
//       URL duplicates a manually configured one ("Suppressing plugin MCP server ...
//       duplicates manually-configured"), so the plugin's headersHelper never runs.
//       Its key moves into the auto-login key cache first, so nobody has to sign in
//       again, then `claude mcp remove` deletes the entry. Only an entry named
//       `bifrost` whose URL is exactly the plugin's gateway is touched, and only when a
//       key for that gateway exists afterwards: a template like ${BIFROST_VK} counts
//       only when the variable is set here. Claude Desktop's
//       claude_desktop_config.json is not read by Claude Code at startup (only by the
//       explicit `claude mcp add-from-claude-desktop` import), so it never collides
//       and is left alone.
//
// A self-installed bifrost-plugin@bifrost-marketplace next to the org-synced copy is
// handled by managed settings instead, see DISTRIBUTION.md.
//
// Writes only ~/.cache/bifrost-plugin/migrate-legacy.json (reasons and counts, never a
// key or URL). Never throws, always exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const gw = require('./lib/gateway.cjs');
const keyCache = require('./lib/key-cache.cjs');

const EXEC_TIMEOUT_MS = 20000;
const MARKER = () => path.join(keyCache.cacheDir(), 'migrate-legacy.json');

function on(v) {
  return /^(1|true|yes)$/i.test(String(v || '').trim());
}

function claudeJsonPath(env = process.env) {
  const dir = (env.CLAUDE_CONFIG_DIR || '').trim();
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// ${VAR} expanded from env; null when any referenced variable is unset or empty.
function expand(raw, env) {
  let missing = false;
  const out = String(raw).replace(/\$\{([^}]*)\}/g, (_, v) => {
    const val = typeof env[v] === 'string' ? env[v].trim() : '';
    if (!val) missing = true;
    return val;
  });
  return missing ? null : out.trim();
}

// What to do with one hand-registered `bifrost` entry. Pure.
// Returns { action: 'remove', vk } (vk null when the cache already holds a key for the
// gateway) or { action: 'skip', reason }.
function legacyServerPlan({ enabled, entry, gateway, cached, env = process.env }) {
  if (!enabled) return { action: 'skip', reason: 'disabled' };
  if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') return { action: 'skip', reason: 'absent' };
  const url = expand(entry.url, env);
  if (!url || !gateway || !gw.sameEndpoint(url, gateway)) return { action: 'skip', reason: 'other-gateway' };
  const hasCache = !!(cached && gw.sameEndpoint(cached.url, gateway));
  const raw = entry.headers && typeof entry.headers['x-bf-vk'] === 'string' ? entry.headers['x-bf-vk'].trim() : '';
  const vk = raw ? expand(raw, env) : '';
  if (hasCache) return { action: 'remove', vk: null };
  if (!vk) return { action: 'skip', reason: raw ? 'unresolved-template' : 'no-key' };
  return { action: 'remove', vk };
}

// `claude mcp remove -s local` resolves the project from the working directory and
// moves up to the git root, so a project entry inside someone else's repository could
// make it edit the wrong entry. Only run it where the entry's own directory is the
// project Claude Code would resolve.
function localScopeSafe(dir) {
  try {
    if (!fs.statSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) return false;
  } catch (_) { return false; }
  for (let d = path.dirname(dir); d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return false;
  }
  return true;
}

function claudeBin(env = process.env) {
  const p = (env.CLAUDE_CODE_EXECPATH || '').trim();
  return p && fs.existsSync(p) ? p : 'claude';
}

function run(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile(claudeBin(), args, { cwd, timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err) => resolve(err ? 'failed' : 'ok'));
    } catch (_) { resolve('failed'); }
  });
}

async function main() {
  const result = { at: Date.now() };
  const enabled = on(gw.pluginOption('migrate_legacy'));
  const name = gw.pluginName();
  const gateway = gw.pluginOption('gateway_url');
  const serverKey = `plugin:${name}:bifrost`;

  // User scope first, then project (local scope) entries.
  const cfg = readJson(claudeJsonPath()) || {};
  const plan = (entry) => legacyServerPlan({ enabled, entry, gateway, cached: keyCache.read() });
  const adopt = (p) => !p.vk || keyCache.write(gateway, p.vk);

  const user = plan(cfg.mcpServers && cfg.mcpServers.bifrost);
  if (user.action === 'remove' && adopt(user)) {
    result.user = await run(['mcp', 'remove', 'bifrost', '-s', 'user'], os.homedir());
  } else {
    result.user = user.reason || 'persist-failed';
  }

  result.local = { removed: 0, skipped: 0 };
  for (const [dir, proj] of Object.entries(cfg.projects || {})) {
    const p = plan(proj && proj.mcpServers && proj.mcpServers.bifrost);
    if (p.action !== 'remove') continue;
    if (localScopeSafe(dir) && adopt(p) && (await run(['mcp', 'remove', 'bifrost', '-s', 'local'], dir)) === 'ok') {
      result.local.removed++;
    } else {
      result.local.skipped++;
    }
  }
  if (result.user === 'ok' || result.local.removed) keyCache.clearNeedsAuth(serverKey);

  try {
    fs.mkdirSync(keyCache.cacheDir(), { recursive: true });
    fs.writeFileSync(MARKER(), JSON.stringify(result), 'utf8');
  } catch (_) {}
}

if (require.main === module) {
  main().then(() => process.exit(0), () => process.exit(0));
}

module.exports = { legacyServerPlan, localScopeSafe };
