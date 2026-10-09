'use strict';
// Opt-in legacy cleanup (hooks/migrate-legacy.cjs): which hand-registered `bifrost`
// servers it may remove, and the worker end to end against a temp CLAUDE_CONFIG_DIR
// with a stand-in `claude`.
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
  assert.strictEqual(plan({ entry: entry(GW, '${__proto__}') }).reason, 'unresolved-template', 'no prototype lookups');
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

function fixture() {
  return { CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-cfg-')) };
}

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
  const env = fixture();
  const cfgFile = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { bifrost: entry(GW, 'vk_legacy_123'), other: entry(GW, 'vk_other') } }));
  const w = runWorker({ ...env, CLAUDE_PLUGIN_OPTION_MIGRATE_LEGACY: 'true' });
  assert.strictEqual(w.r.status, 0);
  assert.deepStrictEqual(w.calls.map((c) => c.split(' ').slice(1).join(' ')), ['mcp remove bifrost -s user']);
  assert.strictEqual(w.vk.vk, 'vk_legacy_123');
  assert.strictEqual(w.vk.url, GW);
  assert.strictEqual(w.marker.user, 'ok');
  assert.strictEqual(w.marker.plugin, undefined, 'the marketplace self-uninstall was dropped for managed settings');
  assert.doesNotMatch(JSON.stringify(w.marker), /vk_legacy/);
  assert.strictEqual(w.r.stdout + w.r.stderr, '');
});

test('worker: gate off touches nothing', () => {
  const env = fixture();
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { bifrost: entry(GW, 'vk_legacy') } }));
  const w = runWorker(env);
  assert.deepStrictEqual(w.calls, []);
  assert.strictEqual(w.vk, null);
});
