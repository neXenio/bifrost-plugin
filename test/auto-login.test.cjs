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

test('gate: a live lock blocks, a lock older than 2 min is stale', () => {
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lockAt: GO.now - 30 * 1000 }), 'in-flight');
  assert.strictEqual(ss.autoLoginDecision({ ...GO, lockAt: GO.now - 3 * 60 * 1000 }), 'go');
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
// session-start end to end. BIFROST_URL is a plain-http, non-loopback host, so the
// keyapp derived from it is refused as insecure: the spawned worker exits without
// opening a browser during the test run.
// ---------------------------------------------------------------------------

function runSessionStart(env, home, input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.cjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      BIFROST_REFRESH: '0',
      CLAUDE_PROJECT_DIR: home,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      BIFROST_URL: 'http://no-browser.example.test/mcp',
      ...env,
    },
    input: JSON.stringify(input || { hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    timeout: 10000,
  });
}

const NOTICE = /browser window opened for company sign-in/;

test('session-start: enabled + no key + interactive startup → one sign-in notice, attempt recorded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
  const r = runSessionStart({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, NOTICE);
  assert.doesNotMatch(r.stdout, /Run `\/bifrost-setup` to fix/);
  assert.ok(fs.existsSync(path.join(home, '.cache', 'bifrost-plugin', 'auto-login-attempt.json')));

  // Second start inside the cooldown: back to the ordinary not-configured line.
  const again = runSessionStart({ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, home);
  assert.doesNotMatch(again.stdout, NOTICE);
  assert.match(again.stdout, /Run `\/bifrost-setup` to fix/);
});

test('session-start: headless, /clear, or disabled never trigger', () => {
  for (const [env, input] of [
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true', CI: '1' }],
    [{ CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'true' }, { source: 'clear' }],
    [{}],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-ss-'));
    const r = runSessionStart(env, home, input);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, NOTICE);
    assert.ok(!fs.existsSync(path.join(home, '.cache', 'bifrost-plugin', 'auto-login-attempt.json')));
  }
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
