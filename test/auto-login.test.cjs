'use strict';
// Opt-in auto-login (1.8.0): the key cache, the headersHelper that feeds it to the MCP
// connection, env() precedence, and the session-start gates that decide whether a
// browser may open at all.
//
// HOME is pointed at a fresh temp dir BEFORE any plugin module loads, because
// gateway.cjs resolves ~/.claude.json at load time and memoizes what it reads.
//
// Run: npm test  (node --test test/)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-autologin-'));
process.env.HOME = HOME;
for (const k of ['BIFROST_URL', 'BIFROST_VK', 'BIFROST_AUTO_LOGIN',
  'CLAUDE_PLUGIN_OPTION_GATEWAY_URL', 'CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY',
  'CLAUDE_PLUGIN_OPTION_AUTO_LOGIN', 'CLAUDE_PLUGIN_OPTION_KEYAPP_URL']) delete process.env[k];

const keyCache = require('../hooks/lib/key-cache.cjs');
const gw = require('../hooks/lib/gateway.cjs');
const ss = require('../hooks/session-start.cjs');

// The manifest's own gateway_url default: hooks fall back to it when the option was
// never saved (see gateway.cjs pluginOption), so it is the effective gateway here.
const GW = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  .userConfig.gateway_url.default;

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

function helper(env, home) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'vk-headers.cjs')], {
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

// ---------------------------------------------------------------------------
// key-cache
// ---------------------------------------------------------------------------

test('key cache: missing reads as null', () => {
  keyCache.clear();
  assert.strictEqual(keyCache.read(), null);
});

test('key cache: roundtrip keeps url+vk paired, file 0600, dir 0700', () => {
  assert.strictEqual(keyCache.write(GW, 'vk_roundtrip'), true);
  const c = keyCache.read();
  assert.strictEqual(c.url, GW);
  assert.strictEqual(c.vk, 'vk_roundtrip');
  assert.ok(c.at > 0);
  assert.ok(keyCache.keyFile().startsWith(HOME), 'cache must follow HOME at call time');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(keyCache.keyFile()).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(keyCache.cacheDir()).mode & 0o777, 0o700);
  }
  const leftovers = fs.readdirSync(keyCache.cacheDir()).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'atomic write must not leave tmp files');
  keyCache.clear();
});

test('key cache: malformed or half-empty content reads as null', () => {
  fs.mkdirSync(keyCache.cacheDir(), { recursive: true });
  for (const body of ['not json', '{}', JSON.stringify({ url: GW }), JSON.stringify({ url: '', vk: 'x' })]) {
    fs.writeFileSync(keyCache.keyFile(), body);
    assert.strictEqual(keyCache.read(), null, `expected null for ${body}`);
  }
  keyCache.clear();
});

// ---------------------------------------------------------------------------
// vk-headers.cjs (headersHelper)
// ---------------------------------------------------------------------------

test('headersHelper prints {} with no cached key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-helper-'));
  const r = helper({ CLAUDE_CODE_MCP_SERVER_URL: GW }, home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '{}');
  assert.strictEqual(r.stderr, '');
});

test('headersHelper prints the cached key for its own gateway, trailing slash ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-helper-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vk'), JSON.stringify({ url: GW, vk: 'vk_cached', at: 1 }));
  const r = helper({ CLAUDE_CODE_MCP_SERVER_URL: `${GW}/` }, home);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { 'x-bf-vk': 'vk_cached' });
  assert.strictEqual(r.stderr, '');
});

test('headersHelper never offers the cached key to a different gateway', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-helper-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vk'), JSON.stringify({ url: GW, vk: 'vk_cached', at: 1 }));
  assert.strictEqual(helper({ CLAUDE_CODE_MCP_SERVER_URL: 'https://evil.example.test/mcp' }, home).stdout, '{}');
  assert.strictEqual(helper({}, home).stdout, '{}');
});

test('headersHelper survives a corrupt cache file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-helper-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vk'), '{"url":');
  const r = helper({ CLAUDE_CODE_MCP_SERVER_URL: GW }, home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '{}');
});

// ---------------------------------------------------------------------------
// env() precedence
// ---------------------------------------------------------------------------

test('env(): cache is used when nothing explicit is configured', () => {
  keyCache.write(GW, 'vk_cache');
  assert.deepStrictEqual(gw.env(), { url: GW, vk: 'vk_cache' });
  keyCache.clear();
});

test('env(): explicit env pair beats the cache', () => {
  keyCache.write(GW, 'vk_cache');
  withEnv({ BIFROST_URL: GW, BIFROST_VK: 'vk_env' }, () => {
    assert.deepStrictEqual(gw.env(), { url: GW, vk: 'vk_env' });
  });
  keyCache.clear();
});

test('env(): plugin option pair beats the cache', () => {
  keyCache.write(GW, 'vk_cache');
  withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: GW, CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'vk_opt' }, () => {
    assert.deepStrictEqual(gw.env(), { url: GW, vk: 'vk_opt' });
  });
  keyCache.clear();
});

test('env(): a saved virtual_key alone pairs with the default gateway, like the static header', () => {
  withEnv({ CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'vk_opt' }, () => {
    assert.deepStrictEqual(gw.env(), { url: GW, vk: 'vk_opt' });
  });
});

test('env(): cached key pairs with a lone gateway option only when it is the same endpoint', () => {
  keyCache.write(GW, 'vk_cache');
  withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: `${GW}/` }, () => {
    assert.deepStrictEqual(gw.env(), { url: GW, vk: 'vk_cache' });
  });
  withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://other.example.test/mcp' }, () => {
    assert.deepStrictEqual(gw.env(), { url: '', vk: '' });
  });
  withEnv({ BIFROST_URL: 'https://other.example.test/mcp' }, () => {
    assert.deepStrictEqual(gw.env(), { url: '', vk: '' });
  });
  keyCache.clear();
});

// ---------------------------------------------------------------------------
// session-start gating
// ---------------------------------------------------------------------------

const GO = { enabled: true, hasKey: false, headless: false, source: 'startup', lastAttemptAt: null, lockAt: null, now: 1e12 };

test('gate: every condition met → go', () => {
  assert.strictEqual(ss.autoLoginDecision(GO), 'go');
});

test('gate: each failing condition blocks with its own reason', () => {
  assert.strictEqual(ss.autoLoginDecision({ ...GO, enabled: false }), 'disabled');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, hasKey: true }), 'has-key');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, headless: true }), 'headless');
  for (const source of ['clear', 'compact', 'resume', undefined]) {
    assert.strictEqual(ss.autoLoginDecision({ ...GO, source }), 'not-startup');
  }
});

test('gate: 6h cooldown after an attempt, then it may retry', () => {
  const h = 60 * 60 * 1000;
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lastAttemptAt: GO.now - 5 * h }), 'cooldown');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lastAttemptAt: GO.now - 7 * h }), 'go');
});

test('gate: a live lock blocks, a lock older than 6 min (past the 5 min worker timeout) is stale', () => {
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lockAt: GO.now - 30 * 1000 }), 'in-flight');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lockAt: GO.now - 5 * 60 * 1000 }), 'in-flight');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lockAt: GO.now - 7 * 60 * 1000 }), 'go');
});

test('gate: a timed-out attempt records its own 30 min cooldown', () => {
  const m = 60 * 1000;
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lastAttemptAt: GO.now - 20 * m, cooldownMs: 30 * m }), 'cooldown');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lastAttemptAt: GO.now - 31 * m, cooldownMs: 30 * m }), 'go');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lastAttemptAt: GO.now - 31 * m }), 'cooldown', 'default stays 6 h');
});

test('gate: Cowork and remote sessions never open a browser', () => {
  assert.strictEqual(ss.autoLoginDecision({ ...GO, remote: true }), 'remote');
  assert.strictEqual(ss.isRemote({ CLAUDE_CODE_IS_COWORK: '1' }), true);
  assert.strictEqual(ss.isRemote({ CLAUDE_CODE_REMOTE: 'true' }), true);
  assert.strictEqual(ss.isRemote({ CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' }), true);
  assert.strictEqual(ss.isRemote({ CLAUDE_CODE_ENTRYPOINT: 'remote' }), true);
  for (const env of [{}, { CLAUDE_CODE_IS_COWORK: '0' }, { CLAUDE_CODE_REMOTE: 'false' }, { CLAUDE_CODE_IS_COWORK: ' ' },
    { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }]) {
    assert.strictEqual(ss.isRemote(env), false, JSON.stringify(env));
  }
});

test('one identity: a saved virtual_key clears the cache, an env pair replaces it, otherwise keep', () => {
  const cached = { url: GW, vk: 'vk_cache', at: 1 };
  assert.strictEqual(ss.cacheConflict({ cached, gateway: `${GW}/`, optVk: 'vk_opt' }), 'clear');
  assert.strictEqual(ss.cacheConflict({ cached, gateway: 'https://other.test/mcp', optVk: 'vk_opt' }), 'keep');
  assert.strictEqual(ss.cacheConflict({ cached, gateway: GW, envUrl: GW, envVk: 'vk_env' }), 'replace');
  assert.strictEqual(ss.cacheConflict({ cached, gateway: GW, envUrl: GW, envVk: 'vk_cache' }), 'keep');
  assert.strictEqual(ss.cacheConflict({ cached, gateway: GW, envVk: 'vk_env' }), 'keep', 'a lone BIFROST_VK is ignored by env() too');
  assert.strictEqual(ss.cacheConflict({ cached: null, gateway: GW, optVk: 'vk_opt' }), 'keep');
});

test('pluginOption: saved value wins, else the manifest default, empty counts as unset', () => {
  assert.strictEqual(gw.pluginOption('gateway_url', {}), GW);
  assert.strictEqual(gw.pluginOption('gateway_url', { CLAUDE_PLUGIN_OPTION_GATEWAY_URL: '' }), GW);
  assert.strictEqual(gw.pluginOption('gateway_url', { CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://x.test/mcp' }), 'https://x.test/mcp');
  assert.strictEqual(gw.pluginOption('auto_login', {}), 'false');
  assert.strictEqual(gw.pluginOption('keyapp_url', {}), '');
});

test('enabled flag: option or env, true/1/yes only', () => {
  assert.strictEqual(ss.autoLoginEnabled({}), false);
  assert.strictEqual(ss.autoLoginEnabled({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'false' }), false);
  assert.strictEqual(ss.autoLoginEnabled({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }), true);
  assert.strictEqual(ss.autoLoginEnabled({ BIFROST_AUTO_LOGIN: '1' }), true);
});

test('headless: observed -p signals and CI count, interactive and Desktop do not', () => {
  assert.strictEqual(ss.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1' }), false);
  assert.strictEqual(ss.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), false);
  assert.strictEqual(ss.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDE_CODE_SESSION_ATTENDED: '0' }), true);
  assert.strictEqual(ss.isHeadless({ CLAUDE_CODE_SESSION_ATTENDED: '0' }), true);
  assert.strictEqual(ss.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), true);
  assert.strictEqual(ss.isHeadless({ CI: 'true', CLAUDE_CODE_ENTRYPOINT: 'cli' }), true);
});

// ---------------------------------------------------------------------------
// session-start end to end. The browser opener (`open` / `xdg-open`) is replaced by a
// shim on PATH that only logs its arguments, and the keyapp is an https host that does
// not exist, so nothing real is ever opened or contacted.
// ---------------------------------------------------------------------------

const SHIM = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-shim-'));
const SHIM_LOG = path.join(SHIM, 'open.log');
for (const bin of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(SHIM, bin), `#!/bin/sh\necho "$@" >> "${SHIM_LOG}"\n`, { mode: 0o755 });
}

function runSessionStart(env, home, input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.cjs')], {
    env: {
      PATH: `${SHIM}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      BIFROST_REFRESH: '0',
      CLAUDE_PROJECT_DIR: home,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      BIFROST_URL: 'https://no-browser.example.invalid/mcp',
      BIFROST_KEYAPP_URL: 'https://keyapp.example.invalid',
      BIFROST_SETUP_TIMEOUT_MS: '1500',
      ...env,
    },
    input: JSON.stringify(input || { hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    timeout: 10000,
  });
}

const NOTICE = /Opening your browser for Bifrost sign-in/;
const attemptFile = (home) => path.join(home, '.cache', 'bifrost-plugin', 'auto-login-attempt.json');

test('session-start: enabled + no key + interactive startup → one sign-in notice, attempt recorded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  const r = runSessionStart({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, NOTICE);
  assert.match(r.stdout, /choose Reconnect \(not Authenticate\)/);
  assert.doesNotMatch(r.stdout, /Run `\/bifrost-setup` to fix/);
  assert.ok(fs.existsSync(attemptFile(home)));

  // Second start inside the cooldown: back to the ordinary not-configured line.
  const again = runSessionStart({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, home);
  assert.doesNotMatch(again.stdout, NOTICE);
  assert.match(again.stdout, /Run `\/bifrost-setup` to fix/);
});

test('session-start: headless, /clear, Cowork, remote or disabled never trigger', () => {
  for (const [env, input] of [
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CI: '1' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, { source: 'clear' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CLAUDE_CODE_IS_COWORK: '1' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' }],
    [{}],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
    const r = runSessionStart(env, home, input);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, NOTICE);
    assert.ok(!fs.existsSync(attemptFile(home)));
  }
});

test('session-start: an http keyapp (explicit or derived from the gateway) neither announces a browser nor burns the cooldown', () => {
  for (const env of [
    { CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', BIFROST_KEYAPP_URL: 'http://keyapp.example.invalid' },
    { CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', BIFROST_KEYAPP_URL: '', CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'http://no-browser.example.invalid/mcp' },
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
    const r = runSessionStart(env, home);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, NOTICE);
    assert.match(r.stdout, /Run `\/bifrost-setup` to fix/);
    assert.ok(!fs.existsSync(attemptFile(home)));
    assert.ok(!fs.existsSync(path.join(home, '.cache', 'bifrost-plugin', 'auto-login.lock')));
  }
});

test('session-start: a cached key for the plugin gateway blocks re-login even under a stale lone BIFROST_URL', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vk'), JSON.stringify({ url: GW, vk: 'vk_cached', at: 1 }));
  const r = runSessionStart({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', BIFROST_URL: 'https://stale.example.invalid/mcp' }, home);
  assert.doesNotMatch(r.stdout, NOTICE);
  assert.ok(!fs.existsSync(attemptFile(home)));
});

test('session-start: with a key configured, output is identical whether auto-login is on or off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  const keyed = { BIFROST_URL: GW, BIFROST_VK: 'vk_present' };
  const off = runSessionStart(keyed, home);
  const on = runSessionStart({ ...keyed, CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, home);
  assert.strictEqual(on.stdout, off.stdout);
  assert.doesNotMatch(on.stdout, NOTICE);
  assert.doesNotMatch(on.stdout, /vk_present/);
});

test('session-start: a saved virtual_key removes a cached key for the same gateway', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vk'), JSON.stringify({ url: GW, vk: 'vk_cached', at: 1 }));
  const r = runSessionStart({ BIFROST_URL: '', CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'vk_saved' }, home);
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'vk')));
  assert.doesNotMatch(r.stdout, /not configured/, 'the hooks must run on the saved key once the cache is gone');
  assert.doesNotMatch(r.stdout, /vk_saved/);
});

test('session-start: migrate_legacy off never spawns the cleanup or writes its marker', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  runSessionStart({}, home);
  assert.ok(!fs.existsSync(path.join(home, '.cache', 'bifrost-plugin', 'migrate-legacy.json')));
});

// ---------------------------------------------------------------------------
// auto-setup.cjs worker: callback success clears the needs-auth record (D1), a timeout
// records the short cooldown (D5).
// ---------------------------------------------------------------------------

function startWorker(home, env) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'auto-setup.cjs')], {
    env: {
      PATH: `${SHIM}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      BIFROST_URL: GW,
      BIFROST_KEYAPP_URL: 'https://keyapp.example.invalid',
      ...env,
    },
    stdio: 'ignore',
  });
  return new Promise((resolve) => child.on('exit', resolve));
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('worker: a successful sign-in caches the key and drops only this plugin\'s needs-auth entry', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-worker-'));
  const cfgDir = path.join(home, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  const name = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const needsAuth = path.join(cfgDir, 'mcp-needs-auth-cache.json');
  fs.writeFileSync(needsAuth, JSON.stringify({ [`plugin:${name}:bifrost`]: { timestamp: 1 }, 'plugin:other:x': { timestamp: 2 } }));
  try { fs.unlinkSync(SHIM_LOG); } catch (_) {}

  const exited = startWorker(home, { BIFROST_SETUP_TIMEOUT_MS: '8000' });
  const line = await waitFor(() => { try { return fs.readFileSync(SHIM_LOG, 'utf8'); } catch (_) { return ''; } });
  const cb = new URL(decodeURIComponent(line.match(/cb=([^\s]+)/)[1]));
  cb.searchParams.set('vk', 'vk_from_signin');
  const status = await new Promise((resolve) => require('http').get(cb, (res) => { res.resume(); resolve(res.statusCode); }));
  await exited;

  assert.strictEqual(status, 200);
  const cached = JSON.parse(fs.readFileSync(path.join(home, '.cache', 'bifrost-plugin', 'vk'), 'utf8'));
  assert.strictEqual(cached.vk, 'vk_from_signin');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(needsAuth, 'utf8')), { 'plugin:other:x': { timestamp: 2 } });
});

test('worker: a stale lone BIFROST_URL never decides where the key is cached', async () => {
  const setup = require('../hooks/auto-setup.cjs');
  assert.strictEqual(setup.gatewayUrl({ BIFROST_URL: 'https://stale.example.test/mcp' }), GW);
  assert.strictEqual(setup.gatewayUrl({ BIFROST_URL: 'https://paired.example.test/mcp', BIFROST_VK: 'vk' }), 'https://paired.example.test/mcp');
  assert.strictEqual(setup.gatewayUrl({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://opt.example.test/mcp' }), 'https://opt.example.test/mcp');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-worker-'));
  try { fs.unlinkSync(SHIM_LOG); } catch (_) {}
  const exited = startWorker(home, { BIFROST_URL: 'https://stale.example.test/mcp', BIFROST_SETUP_TIMEOUT_MS: '8000' });
  const line = await waitFor(() => { try { return fs.readFileSync(SHIM_LOG, 'utf8'); } catch (_) { return ''; } });
  const cb = new URL(decodeURIComponent(line.match(/cb=([^\s]+)/)[1]));
  cb.searchParams.set('vk', 'vk_n2');
  await new Promise((resolve) => require('http').get(cb, (res) => { res.resume(); resolve(); }));
  await exited;
  const cached = JSON.parse(fs.readFileSync(path.join(home, '.cache', 'bifrost-plugin', 'vk'), 'utf8'));
  assert.strictEqual(cached.url, GW, 'cached for the plugin gateway, not the stale export');
});

test('worker: a timeout shortens the cooldown of an automatic attempt to 30 min', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-worker-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auto-login-attempt.json'), JSON.stringify({ at: 1 }));
  await startWorker(home, { BIFROST_SETUP_TIMEOUT_MS: '300' });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'auto-login-attempt.json'), 'utf8'));
  assert.strictEqual(m.cooldownMs, 30 * 60 * 1000);
  assert.ok(m.at > 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auto-setup-result.json'), 'utf8')).reason, 'timeout');
});

test('needs-auth: clearNeedsAuth keeps other entries and is a no-op without the file or entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-na-'));
  withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
    assert.strictEqual(keyCache.clearNeedsAuth('plugin:p:bifrost'), false);
    fs.writeFileSync(keyCache.needsAuthFile(), JSON.stringify({ a: { timestamp: 1 } }));
    assert.strictEqual(keyCache.clearNeedsAuth('plugin:p:bifrost'), false);
    fs.writeFileSync(keyCache.needsAuthFile(), '{"a":');
    assert.strictEqual(keyCache.clearNeedsAuth('plugin:p:bifrost'), false);
    assert.strictEqual(fs.readFileSync(keyCache.needsAuthFile(), 'utf8'), '{"a":');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });
});

// ---------------------------------------------------------------------------
// D3: a 401 for the cached key forgets it; nothing else does.
// ---------------------------------------------------------------------------

function fakeGateway(status) {
  const http = require('http');
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(status); res.end('{}'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('rpc: a 401 with the cached key clears the cache and the cooldown marker', async () => {
  const server = await fakeGateway(401);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  keyCache.write(url, 'vk_revoked');
  fs.writeFileSync(path.join(keyCache.cacheDir(), 'auto-login-attempt.json'), JSON.stringify({ at: Date.now() }));
  await withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: url }, () => gw.rpc('initialize', {}, 2000));
  server.close();
  assert.strictEqual(keyCache.read(), null);
  assert.ok(!fs.existsSync(path.join(keyCache.cacheDir(), 'auto-login-attempt.json')));
});

test('rpc: a 5xx or a network error keeps the cached key', async () => {
  const server = await fakeGateway(503);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  keyCache.write(url, 'vk_kept');
  await withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: url }, () => gw.rpc('initialize', {}, 2000));
  server.close();
  assert.strictEqual(keyCache.read().vk, 'vk_kept');
  await withEnv({ CLAUDE_PLUGIN_OPTION_GATEWAY_URL: url }, () => gw.rpc('initialize', {}, 2000));
  assert.strictEqual(keyCache.read().vk, 'vk_kept', 'connection refused must not clear the key');
  keyCache.clear();
});

test('rpc: a 401 for a key from another source leaves the cache alone', async () => {
  const server = await fakeGateway(401);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  keyCache.write(url, 'vk_cached');
  await withEnv({ BIFROST_URL: url, BIFROST_VK: 'vk_env' }, () => gw.rpc('initialize', {}, 2000));
  server.close();
  assert.strictEqual(keyCache.read().vk, 'vk_cached');
  keyCache.clear();
});
