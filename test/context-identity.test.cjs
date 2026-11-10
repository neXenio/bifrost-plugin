'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-context-identity-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const gw = require('../hooks/lib/gateway.cjs');
const session = require('../hooks/session-start.cjs');
const { scopeKey, injectFile, injectScope } = require('../hooks/lib/cache-scope.cjs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function hook(name, env, args = [], preload = '') {
  const script = path.join(testHome, 'preload.cjs');
  fs.writeFileSync(script, preload);
  const r = spawnSync(process.execPath, ['--require', script, path.join(root, 'hooks', name), ...args], {
    env: { ...process.env, BIFROST_REFRESH: '0', BIFROST_PLUGIN_CONFIG: '0', ...env },
    input: JSON.stringify({ prompt: 'Implement the identity fix', session_id: 'identity-test' }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout;
}

async function server(t, change = () => {}, answer = () => null) {
  const keys = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      keys.push(req.headers['x-bf-vk']);
      change(msg);
      if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = answer(msg) || (msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'identity_A-skill_search' }] });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  process.env.BIFROST_URL = `http://127.0.0.1:${s.address().port}/mcp`;
  process.env.BIFROST_VK = 'identity-A';
  t.after(() => { s.closeAllConnections(); s.close(); });
  return keys;
}

test('discovery and project context are isolated across effective identities', async t => {
  await server(t);
  const a = await gw.getCapabilities(1000, { refresh: true });
  assert.equal(a.skills.server, 'identity_A');
  const fileA = session.cacheFile();
  process.env.BIFROST_VK = 'identity-B';
  assert.equal(await gw.getCapabilities(0, { cacheOnly: true }), null);
  assert.notEqual(session.cacheFile(), fileA);
  process.env.BIFROST_VK = 'identity-A';
  assert.equal((await gw.getCapabilities(0, { cacheOnly: true })).skills.server, 'identity_A');
});

test('discovery captures one identity across handshake, network and cache write', async t => {
  const keys = await server(t, msg => {
    if (msg.method === 'initialize') process.env.BIFROST_VK = 'identity-B';
  });
  await gw.getCapabilities(1000, { refresh: true });
  assert.ok(keys.every(key => key === 'identity-A'));
  assert.equal(await gw.getCapabilities(0, { cacheOnly: true }), null);
  process.env.BIFROST_VK = 'identity-A';
  assert.equal((await gw.getCapabilities(0, { cacheOnly: true })).skills.server, 'identity_A');
});

test('discovery rejects legacy, wrong-scope, endpoint-changed and keyless caches', async t => {
  await server(t);
  const a = await gw.getCapabilities(1000, { refresh: true });
  const endpoint = process.env.BIFROST_URL;
  process.env.BIFROST_URL += '?other-tenant';
  write(path.join(testHome, '.cache/bifrost-plugin/discovery.json'), a);
  assert.equal(await gw.getCapabilities(0, { cacheOnly: true }), null);
  write(gw.discoveryCacheFile(), a);
  assert.equal(await gw.getCapabilities(0, { cacheOnly: true }), null);
  process.env.BIFROST_URL = endpoint;
  process.env.BIFROST_VK = '';
  assert.equal(gw.discoveryCacheFile(), null);
  assert.equal(await gw.getCapabilities(0, { cacheOnly: true }), null);
  assert.equal(session.cacheFile(), null);
});

test('failed catalog reads carry only the captured identity roster', async t => {
  const keys = await server(t, msg => {
    if (msg.method === 'initialize') process.env.BIFROST_VK = 'identity-B';
  }, msg => msg.method === 'tools/list' ? { tools: [{ name: 'listToolFiles' }] }
    : msg.method === 'tools/call' ? { content: [{ text: msg.params.name === 'listToolFiles' ? '  skills.pyi' : '' }] } : null);
  const url = process.env.BIFROST_URL;
  for (const vk of ['identity-A', 'identity-B']) {
    write(gw.discoveryCacheFile({ url, vk }), { at: Date.now(), cacheScope: scopeKey(url, vk), roster: { skills: [vk === 'identity-A' ? 'skill_search' : 'private_B'] } });
  }
  const caps = await gw.getCapabilities(1000, { refresh: true });
  assert.deepEqual(caps.roster.skills, ['skill_search']);
  assert.ok(keys.every(key => key === 'identity-A'));
});

test('injected context isolates identity, endpoint and project; legacy and forged scope miss', () => {
  const project = fs.mkdtempSync(path.join(testHome, 'project-'));
  const url = 'https://fixture.invalid/mcp';
  const env = { CLAUDE_PROJECT_DIR: project, BIFROST_URL: url, BIFROST_VK: 'identity-A', BIFROST_MEMORY_PRIME: '1' };
  const file = injectFile(project, url, env.BIFROST_VK);
  const payload = { v: 2, at: Date.now(), cacheScope: injectScope(project, url, env.BIFROST_VK), skills: { server: 'private_A', mode: 'flat' } };
  write(file, payload);
  assert.match(hook('session-start.cjs', env), /private_A/);
  const b = { ...env, BIFROST_VK: 'identity-B' };
  write(path.join(testHome, '.cache/bifrost-plugin', path.basename(file)), payload);
  assert.doesNotMatch(hook('session-start.cjs', b), /private_A/);
  write(injectFile(project, url, b.BIFROST_VK), payload);
  for (const changed of [b, { ...env, BIFROST_VK: '' }, { ...env, BIFROST_URL: url + '/other' }, { ...env, CLAUDE_PROJECT_DIR: project + '-other' }]) {
    assert.doesNotMatch(hook('session-start.cjs', changed), /private_A/);
  }
  assert.match(hook('session-start.cjs', env), /private_A/);
});

test('detached refresh refuses foreign and legacy destinations, retains policy-only refresh', () => {
  const project = testHome;
  const url = 'https://fixture.invalid/mcp';
  const fileA = injectFile(project, url, 'identity-A');
  const policyMark = path.join(testHome, 'policy-refresh');
  const preload = `const pc = require(${JSON.stringify(path.join(root, 'hooks/lib/plugin-config.cjs'))});
    pc.refreshAndRecord = async () => require('fs').writeFileSync(${JSON.stringify(policyMark)}, 'called');
    require(${JSON.stringify(path.join(root, 'hooks/lib/gateway.cjs'))}).getCapabilities = async () => { throw new Error('must not discover'); };`;
  for (const file of [fileA, path.join(testHome, 'legacy.json'), '']) {
    write(file || path.join(testHome, 'unused.json'), { sentinel: true });
    hook('refresh.cjs', { BIFROST_URL: url, BIFROST_VK: file ? 'identity-B' : '' }, [file, '--dir', project], preload);
    assert.equal(fs.readFileSync(policyMark, 'utf8'), 'called');
    if (file) assert.deepEqual(JSON.parse(fs.readFileSync(file)), { sentinel: true });
  }
});

test('prompt suppresses late recall and nudge after identity changes, preserving captured network key', () => {
  const gwPath = JSON.stringify(path.join(root, 'hooks/lib/gateway.cjs'));
  const receipt = path.join(testHome, 'recall-key.json');
  const preload = `const gw = require(${gwPath});
    gw.getCapabilities = async () => ({ memory: { server: 'private_A', mode: 'flat', tool: 'memory_search' } });
    gw.callCapability = async (...args) => {
      require('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(args[4].vk));
      process.env.BIFROST_VK = 'identity-B';
      return JSON.stringify([{ content: 'private_A_fact', similarity: 0.9 }]);
    };`;
  assert.equal(hook('prompt-submit.cjs', { BIFROST_URL: 'https://fixture.invalid/mcp', BIFROST_VK: 'identity-A' }, [], preload), '');
  assert.equal(JSON.parse(fs.readFileSync(receipt)), 'identity-A');
  const duringDiscovery = `const gw = require(${gwPath}); gw.getCapabilities = async () => { process.env.BIFROST_VK = 'identity-B'; return null; };`;
  assert.equal(hook('prompt-submit.cjs', { BIFROST_URL: 'https://fixture.invalid/mcp', BIFROST_VK: 'identity-A' }, [], duringDiscovery), '');
});

test('late refresh writes only A and never merges foreign injected metadata', () => {
  const url = 'https://fixture.invalid/mcp';
  const fileA = injectFile(testHome, url, 'identity-A');
  const fileB = injectFile(testHome, url, 'identity-B');
  const b = { v: 2, at: Date.now(), cacheScope: injectScope(testHome, url, 'identity-B'), skills: { count: 987 }, memory: { total: 456, facts: [{ content: 'private_B', similarity: 0.9 }] } };
  write(fileA, b);
  write(fileB, b);
  const preload = `const gw = require(${JSON.stringify(path.join(root, 'hooks/lib/gateway.cjs'))});
    gw.getCapabilities = async () => { process.env.BIFROST_VK = 'identity-B'; return { skills: { server: 'private_A', mode: 'flat' }, memory: { server: 'private_A', mode: 'flat' } }; };
    gw.callCapability = async (...args) => { require('fs').writeFileSync(${JSON.stringify(path.join(testHome, 'refresh-key'))}, args[4].vk); return '[]'; };`;
  hook('refresh.cjs', { CLAUDE_PROJECT_DIR: testHome, BIFROST_URL: url, BIFROST_VK: 'identity-A', BIFROST_MEMORY_PRIME: '1' }, [fileA, 'identity query'], preload);
  assert.equal(fs.readFileSync(path.join(testHome, 'refresh-key'), 'utf8'), 'identity-A');
  const a = JSON.parse(fs.readFileSync(fileA));
  assert.equal(a.cacheScope, injectScope(testHome, url, 'identity-A'));
  assert.equal(a.skills.count, undefined);
  assert.equal(a.memory.total, undefined);
  assert.deepEqual(a.memory.facts, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(fileB)), b);
});

test('reflection emits no late identity context after discovery await', () => {
  const receipt = path.join(testHome, 'reflect-called');
  write(path.join(testHome, '.cache/bifrost-plugin/reflect/identity-test.json'), { turns: 2, prompts: 0 });
  const preload = `require(${JSON.stringify(path.join(root, 'hooks/lib/gateway.cjs'))}).getCapabilities = async () => {
    require('fs').writeFileSync(${JSON.stringify(receipt)}, 'called');
    process.env.BIFROST_VK = 'identity-B'; return { memory: { server: 'private_A', mode: 'flat' } };
  };`;
  assert.equal(hook('session-reflect.cjs', { CLAUDE_PROJECT_DIR: testHome, BIFROST_URL: 'https://fixture.invalid/mcp', BIFROST_VK: 'identity-A' }, [], preload), '');
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'called');
});
