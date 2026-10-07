'use strict';
// Opt-in legacy cleanup (hooks/migrate-legacy.cjs): which hand-registered `bifrost`
// servers it may remove, when a marketplace copy may hand over to the synced one, and
// the worker end to end against a temp CLAUDE_CONFIG_DIR with a stand-in `claude`.
//
// Run: node --test test/migrate-legacy.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-migrate-'));

const m = require('../hooks/migrate-legacy.cjs');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const NAME = MANIFEST.name;
const GW = MANIFEST.userConfig.gateway_url.default;
const entry = (url, vk) => ({ type: 'http', url, ...(vk === undefined ? {} : { headers: { 'x-bf-vk': vk } }) });
const plan = (o) => m.legacyServerPlan({ enabled: true, gateway: GW, cached: null, env: {}, ...o });

// ---------------------------------------------------------------------------
// legacyServerPlan
// ---------------------------------------------------------------------------

test('plan: same gateway (trailing slash ignored) with a literal key → remove and adopt the key', () => {
  assert.deepStrictEqual(plan({ entry: entry(`${GW}/`, 'vk_legacy') }), { action: 'remove', vk: 'vk_legacy' });
});

test('plan: a different gateway, a stdio entry or no entry is never touched', () => {
  assert.strictEqual(plan({ entry: entry('https://other.example.test/mcp', 'vk_x') }).reason, 'other-gateway');
  assert.strictEqual(plan({ entry: { command: 'npx', args: ['mcp-remote', GW] } }).reason, 'absent');
  assert.strictEqual(plan({ entry: undefined }).reason, 'absent');
});

test('plan: ${BIFROST_VK} template counts only when the variable is set here', () => {
  assert.deepStrictEqual(plan({ entry: entry(GW, '${BIFROST_VK}') }), { action: 'skip', reason: 'unresolved-template' });
  assert.deepStrictEqual(plan({ entry: entry(GW, '${BIFROST_VK}'), env: { BIFROST_VK: 'vk_env' } }), { action: 'remove', vk: 'vk_env' });
  assert.deepStrictEqual(plan({ entry: entry('${BIFROST_URL}', 'vk_x'), env: { BIFROST_URL: GW } }), { action: 'remove', vk: 'vk_x' });
  assert.strictEqual(plan({ entry: entry('${BIFROST_URL}', 'vk_x') }).reason, 'other-gateway');
});

test('plan: no usable key and no cached one → keep the entry (it may be the only working setup)', () => {
  assert.strictEqual(plan({ entry: entry(GW) }).reason, 'no-key');
  assert.strictEqual(plan({ entry: entry(GW, '  ') }).reason, 'no-key');
});

test('plan: a cached key for the gateway already exists → remove without overwriting it', () => {
  const cached = { url: GW, vk: 'vk_cache' };
  assert.deepStrictEqual(plan({ entry: entry(GW, 'vk_legacy'), cached }), { action: 'remove', vk: null });
  assert.deepStrictEqual(plan({ entry: entry(GW), cached }), { action: 'remove', vk: null });
  assert.deepStrictEqual(plan({ entry: entry(GW, 'vk_legacy'), cached: { url: 'https://other.test/mcp', vk: 'x' } }),
    { action: 'remove', vk: 'vk_legacy' });
});

test('plan: gate off → nothing, whatever the entry looks like', () => {
  assert.deepStrictEqual(plan({ enabled: false, entry: entry(GW, 'vk_legacy') }), { action: 'skip', reason: 'disabled' });
});

// ---------------------------------------------------------------------------
// selfUninstallPlan + detection
// ---------------------------------------------------------------------------

const GO = { enabled: true, isMarketplaceCopy: true, syncedPresent: true, syncedDisabled: false, env: {} };

test('self-uninstall: only the marketplace copy, only with a live synced copy, only with the gate on', () => {
  assert.strictEqual(m.selfUninstallPlan(GO), 'uninstall');
  assert.strictEqual(m.selfUninstallPlan({ ...GO, enabled: false }), 'disabled');
  assert.strictEqual(m.selfUninstallPlan({ ...GO, isMarketplaceCopy: false }), 'not-marketplace-copy');
  assert.strictEqual(m.selfUninstallPlan({ ...GO, syncedPresent: false }), 'no-synced-copy');
  assert.strictEqual(m.selfUninstallPlan({ ...GO, syncedDisabled: true }), 'synced-disabled');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
    assert.strictEqual(m.selfUninstallPlan({ ...GO, env: { [k]: 'x' } }), 'not-claude-ai-session', k);
  }
});

// Layout as observed on Claude Code 2.1.293: installed_plugins.json, and synced plugins
// under plugins/synced/<organizationUuid>_<accountUuid>/<name>/ with a manifest.json.
function fixture({ installedRoot, synced = true, account = true, disabled = false } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-cfg-'));
  const org = '11111111-aaaa', acct = '22222222-bbbb';
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: installedRoot ? { [`${NAME}@bifrost-marketplace`]: [{ scope: 'user', installPath: installedRoot }] } : {},
  }));
  if (account) fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: org, accountUuid: acct } }));
  if (synced) {
    const bucket = path.join(cfg, 'plugins', 'synced', `${org}_${acct}`);
    fs.mkdirSync(path.join(bucket, NAME, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(bucket, NAME, '.claude-plugin', 'plugin.json'), '{}');
    fs.writeFileSync(path.join(bucket, 'manifest.json'), JSON.stringify({ plugins: [{ name: NAME }] }));
  }
  if (disabled) fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { [`${NAME}@synced`]: false } }));
  return { CLAUDE_CONFIG_DIR: cfg };
}

test('detection: marketplace copy is matched by its install path, through symlinks', () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-link-')), 'root');
  fs.symlinkSync(ROOT, link);
  assert.strictEqual(m.isMarketplaceCopy(NAME, ROOT, fixture({ installedRoot: link })), true);
  assert.strictEqual(m.isMarketplaceCopy(NAME, ROOT, fixture({ installedRoot: os.tmpdir() })), false);
  assert.strictEqual(m.isMarketplaceCopy(NAME, ROOT, fixture({})), false);
});

test('detection: synced copy counts only for the signed-in account and when listed + present', () => {
  assert.strictEqual(m.syncedCopyPresent(NAME, fixture()), true);
  assert.strictEqual(m.syncedCopyPresent(NAME, fixture({ synced: false })), false);
  assert.strictEqual(m.syncedCopyPresent(NAME, fixture({ account: false })), false);
  assert.strictEqual(m.syncedCopyPresent('another-plugin', fixture()), false);
  assert.strictEqual(m.syncedDisabled(NAME, fixture({ disabled: true })), true);
  assert.strictEqual(m.syncedDisabled(NAME, fixture()), false);
});

test('localScopeSafe: only an existing real directory that is not inside a git repository', () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-proj-')));
  assert.strictEqual(m.localScopeSafe(plain), true);
  assert.strictEqual(m.localScopeSafe(path.join(ROOT, 'hooks')), false, 'inside this repository');
  assert.strictEqual(m.localScopeSafe(path.join(plain, 'missing')), false);
});

// ---------------------------------------------------------------------------
// worker end to end, with a stand-in `claude` that only logs its arguments
// ---------------------------------------------------------------------------

function runWorker(env) {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-bin-')), 'claude');
  const log = `${bin}.log`;
  fs.writeFileSync(bin, `#!/bin/sh\necho "$PWD $@" >> "${log}"\n`, { mode: 0o755 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-home-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'migrate-legacy.cjs')], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_EXECPATH: bin, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.cache', 'bifrost-plugin', f), 'utf8')); } catch (_) { return null; } };
  return { r, calls, home, vk: read('vk'), marker: read('migrate-legacy.json') };
}

test('worker: adopts the legacy key, removes the user-scope entry, marker holds no key', () => {
  const env = fixture({ synced: false });
  const cfgFile = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { bifrost: entry(GW, 'vk_legacy_123'), other: entry(GW, 'vk_other') } }));
  const w = runWorker({ ...env, CLAUDE_PLUGIN_OPTION_MIGRATE_LEGACY: 'true' });
  assert.strictEqual(w.r.status, 0);
  assert.deepStrictEqual(w.calls.map((c) => c.split(' ').slice(1).join(' ')), ['mcp remove bifrost -s user']);
  assert.strictEqual(w.vk.vk, 'vk_legacy_123');
  assert.strictEqual(w.vk.url, GW);
  assert.strictEqual(w.marker.user, 'ok');
  assert.strictEqual(w.marker.plugin, 'not-marketplace-copy');
  assert.doesNotMatch(JSON.stringify(w.marker), /vk_legacy/);
  assert.strictEqual(w.r.stdout + w.r.stderr, '');
});

test('worker: gate off touches nothing', () => {
  const env = fixture({ installedRoot: ROOT });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { bifrost: entry(GW, 'vk_legacy') } }));
  const w = runWorker(env);
  assert.deepStrictEqual(w.calls, []);
  assert.strictEqual(w.vk, null);
});

test('worker: marketplace copy next to a synced copy uninstalls itself and keeps its saved key', () => {
  const env = fixture({ installedRoot: ROOT });
  const w = runWorker({ ...env, CLAUDE_PLUGIN_OPTION_MIGRATE_LEGACY: 'true', CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'vk_saved' });
  assert.deepStrictEqual(w.calls.map((c) => c.split(' ').slice(1).join(' ')), [`plugin uninstall ${NAME}@bifrost-marketplace`]);
  assert.strictEqual(w.vk.vk, 'vk_saved');
  assert.strictEqual(w.marker.plugin, 'ok');
});
