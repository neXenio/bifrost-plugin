'use strict';
// Backward-compatibility contract tests for v1.2.0.
//
// Existing clients fall into three groups, and each has a contract these tests
// pin down so future changes can't silently break them:
//   1. Non-plugin clients of the same Bifrost gateway (OpenAI-compatible
//      endpoint, MCP, etc.) — they share the vk_… keys. Contract: the plugin
//      sends the exact same auth header (`x-bf-vk`) and never requires a
//      gateway-side change. Pinned by the wire-format test below.
//   2. Plugin users on the marketplace path. Contract: same MCP server name,
//      transport, env templates (.mcp.json byte-stable), same hook events,
//      same injection env-var switches, and old cache files still render.
//   3. Script/CI users of bin/install.js. Contract: --key / --dry-run / --help
//      flags still work and the server keeps the name `bifrost`.
//
// Run: npm test  (node --test test/)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-compat-'));
}

function runHook(script, env, home) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// Group 2: shipped MCP declaration is byte-stable for existing installs
// ---------------------------------------------------------------------------

test('.mcp.json keeps the exact pre-1.2.0 server shape (name, transport, templates, auth header)', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
  assert.deepStrictEqual(mcp, {
    mcpServers: {
      bifrost: {
        type: 'http',
        url: '${BIFROST_URL}',
        headers: { 'x-bf-vk': '${BIFROST_VK}' },
      },
    },
  });
});

test('hooks.json still registers exactly SessionStart and UserPromptSubmit', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
});

// ---------------------------------------------------------------------------
// Groups 1+2: wire format — same auth header, same JSON-RPC shape
// ---------------------------------------------------------------------------

// gateway.cjs derives its cache dir from HOME at require time, so give each
// test a fresh module bound to an isolated HOME (no cross-test cache leaks).
function freshGateway(home) {
  process.env.HOME = home;
  const p = path.join(ROOT, 'hooks', 'lib', 'gateway.cjs');
  delete require.cache[require.resolve(p)];
  return require(p);
}

function localServer(onRequest) {
  const server = http.createServer((req, res) => {
    onRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('gateway client sends the unchanged x-bf-vk header (loopback http still allowed)', async () => {
  let seen = null;
  const server = await localServer((req) => {
    seen = { header: req.headers['x-bf-vk'], method: req.method };
  });
  const gw = freshGateway(tmpHome());
  process.env.BIFROST_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  process.env.BIFROST_VK = 'vk_compat_test';

  await gw.getCapabilities(3000, { refresh: true });
  server.close();

  assert.ok(seen, 'gateway client never contacted the local server');
  assert.strictEqual(seen.header, 'vk_compat_test');
  assert.strictEqual(seen.method, 'POST');
});

test('cleartext http to a non-loopback host is refused by default, allowed with BIFROST_ALLOW_HTTP=1', async () => {
  // 0.0.0.0 routes to the local listener on Linux but is NOT in the loopback
  // allowlist — so whether the request arrives is decided purely by policy.
  let hits = 0;
  const server = await localServer(() => { hits++; });
  const url = `http://0.0.0.0:${server.address().port}/mcp`;
  process.env.BIFROST_VK = 'vk_compat_test';
  process.env.BIFROST_URL = url;
  delete process.env.BIFROST_ALLOW_HTTP;

  const blocked = await freshGateway(tmpHome()).getCapabilities(1000, { refresh: true });
  assert.strictEqual(blocked, null);
  assert.strictEqual(hits, 0, 'policy should block before any request is sent');

  process.env.BIFROST_ALLOW_HTTP = '1';
  await freshGateway(tmpHome()).getCapabilities(1000, { refresh: true });
  server.close();
  delete process.env.BIFROST_ALLOW_HTTP;
  assert.ok(hits > 0, 'legacy escape hatch should let the request through');
});

// ---------------------------------------------------------------------------
// Group 2: session-start output contract
// ---------------------------------------------------------------------------

test('session-start emits the context block and exits 0 with no gateway configured', () => {
  const home = tmpHome();
  const r = runHook('session-start.cjs', { BIFROST_URL: '', BIFROST_VK: '' }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Bifrost gateway — session context/);
});

test('old (pre-1.1.0) plain-string cache facts still render', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const key = path.basename(proj).replace(/[^A-Za-z0-9_-]/g, '_');
  const cacheDir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `inject-${key}.json`),
    JSON.stringify({ at: Date.now(), memory: { facts: ['legacy plain-string fact'] } })
  );
  const r = runHook('session-start.cjs', {
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: '', BIFROST_VK: '',
  }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /legacy plain-string fact/);
});

test('BIFROST_MEMORY_INJECT=0 still suppresses the memory header', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const key = path.basename(proj).replace(/[^A-Za-z0-9_-]/g, '_');
  const cacheDir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `inject-${key}.json`),
    JSON.stringify({ at: Date.now(), memory: { facts: ['should not appear'] } })
  );
  const r = runHook('session-start.cjs', {
    CLAUDE_PROJECT_DIR: proj, BIFROST_MEMORY_INJECT: '0', BIFROST_URL: '', BIFROST_VK: '',
  }, home);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /should not appear/);
});

// ---------------------------------------------------------------------------
// Group 3: installer CLI contract
// ---------------------------------------------------------------------------

test('install.js keeps --help, --dry-run, --key flags and the server name bifrost', () => {
  const help = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--help'], { encoding: 'utf8' });
  assert.match(help, /--key/);
  assert.match(help, /--dry-run/);

  const dry = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, BIFROST_URL: 'https://gw.example/mcp' },
  });
  assert.match(dry, /claude mcp add --scope user --transport http bifrost https:\/\/gw\.example\/mcp/);
  assert.match(dry, /x-bf-vk/);
});

test('install.js fails loudly (not silently) when BIFROST_URL is unset', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, BIFROST_URL: '' },
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /BIFROST_URL is not set/);
});
