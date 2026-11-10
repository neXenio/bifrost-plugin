'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const gw = require('../hooks/lib/gateway.cjs');

async function gateway(t, respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      calls.push({ msg, headers: req.headers });
      respond(msg, req, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = { url: process.env.BIFROST_URL, vk: process.env.BIFROST_VK };
  process.env.BIFROST_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  process.env.BIFROST_VK = 'test-only-key';
  t.after(() => {
    for (const [key, value] of [['BIFROST_URL', previous.url], ['BIFROST_VK', previous.vk]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    server.close();
  });
  return calls;
}

function json(res, msg, result, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
}

function initialize(msg, res) {
  if (msg.method === 'initialize') {
    json(res, msg, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } }, { 'Mcp-Session-Id': 'fixture-session' });
    return true;
  }
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202); res.end(); return true;
  }
  return false;
}

test('cached capability initializes once before concurrent calls and preserves session headers', async t => {
  const calls = await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    json(res, msg, { content: [{ text: 'ok' }] });
  });
  const cap = { mode: 'flat', server: 'skills', tool: 'skills-skill_search' };
  assert.deepEqual(await Promise.all([gw.callCapability(cap, 'skill_search', {}, 1000), gw.callCapability(cap, 'skill_search', {}, 1000)]), ['ok', 'ok']);
  assert.deepEqual(calls.map(c => c.msg.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  assert.equal(calls[1].msg.id, undefined);
  for (const call of calls.slice(1)) {
    assert.equal(call.headers['mcp-session-id'], 'fixture-session');
    assert.equal(call.headers['mcp-protocol-version'], '2025-06-18');
  }
  assert.notEqual(calls[2].msg.id, calls[3].msg.id);
});

test('SSE selects matching response across notifications, other ids and multiline events without waiting for close', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': heartbeat\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n');
    res.write('data: {"jsonrpc":"2.0","id":-1,"result":{}}\n\n');
    res.write(`data: {"jsonrpc":"2.0","id":${msg.id},\ndata: "result":{"content":[{"text":"right"}]}}\n\n`);
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 400), 'right');
});

test('unsupported protocol, JSON-RPC errors and invalid initialize results fail closed', async t => {
  const calls = await gateway(t, (msg, req, res) => json(res, msg, { protocolVersion: '2099-01-01' }));
  assert.equal(await gw.discover(300), null);
  assert.equal(calls.length, 1);
});

test('matching JSON-RPC errors never produce capability text', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'failure' }, result: { content: [{ text: 'wrong' }] } }));
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 300), null);
});

test('JSON response id mismatch and HTTP errors cannot become discovery results', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    json(res, { id: -1 }, { tools: [] });
  });
  assert.equal(await gw.discover(300), null);
});

test('expired sessions are invalidated without replaying calls', async t => {
  let failed = false;
  const calls = await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    if (!failed) { failed = true; res.writeHead(404); res.end(); return; }
    json(res, msg, { content: [{ text: 'reconnected' }] });
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 300), null);
  assert.equal(calls.filter(c => c.msg.method === 'tools/call').length, 1);
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 300), 'reconnected');
  assert.equal(calls.filter(c => c.msg.method === 'initialize').length, 2);
});

test('changing credentials creates a fresh session', async t => {
  const calls = await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    json(res, msg, { content: [{ text: 'ok' }] });
  });
  await gw.callCapability({ mode: 'flat' }, 'search', {}, 300);
  process.env.BIFROST_VK = 'another-test-key';
  await gw.callCapability({ mode: 'flat' }, 'search', {}, 300);
  assert.equal(calls.filter(c => c.msg.method === 'initialize').length, 2);
  assert.equal(calls[3].headers['mcp-session-id'], undefined);
  assert.equal(calls[3].headers['x-bf-vk'], 'another-test-key');
});

test('progress traffic cannot extend the request deadline', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tick = setInterval(() => res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'), 10);
    res.on('close', () => clearInterval(tick));
  });
  const start = Date.now();
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 80), null);
  assert.ok(Date.now() - start < 500);
});

test('invalid initialize result and rejected initialized notification stop before tools', async t => {
  let badResult = true;
  const calls = await gateway(t, (msg, req, res) => {
    if (msg.method === 'initialize' && badResult) { json(res, msg, {}); return; }
    if (msg.method === 'notifications/initialized') { res.writeHead(400); res.end(); return; }
    initialize(msg, res);
  });
  assert.equal(await gw.discover(300), null);
  badResult = false;
  assert.equal(await gw.discover(300), null);
  assert.deepEqual(calls.map(c => c.msg.method), ['initialize', 'initialize', 'notifications/initialized']);
});

test('discovery keeps its own deadline while another caller initializes', async t => {
  let started;
  const initializing = new Promise(resolve => { started = resolve; });
  await gateway(t, (msg, req, res) => {
    if (msg.method === 'initialize') {
      started();
      setTimeout(() => initialize(msg, res), 200);
      return;
    }
    if (initialize(msg, res)) return;
    json(res, msg, { tools: [] });
  });
  const first = gw.rpc('tools/list', {}, 1000);
  await initializing;
  const start = Date.now();
  assert.equal(await gw.discover(30), null);
  assert.ok(Date.now() - start < 150);
  assert.equal((await first).status, 200);
});

test('SSE accepts mixed line endings and CRLF split across chunks', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\r');
    setTimeout(() => {
      res.write('\n\n');
      res.write(`data: {"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"text":"mixed"}]}}\n\r\n`);
    }, 5);
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 300), 'mixed');
});

test('oversized incomplete SSE is rejected before its timeout', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + 'x'.repeat(5 * 1024 * 1024));
  });
  const start = Date.now();
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 1500), null);
  assert.ok(Date.now() - start < 900, 'oversized stream waited for the request timeout');
});

test('SSE retains split UTF-8 text after many independent events', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 100; i++) res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
    const event = Buffer.from(`data: {"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"text":"Grüße🙂"}]}}\n\n`);
    const split = event.indexOf(Buffer.from('🙂')) + 1;
    res.write(event.subarray(0, split));
    setTimeout(() => res.write(event.subarray(split)), 5);
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 300), 'Grüße🙂');
});

test('matching SSE error is terminal even if followed by a duplicate success', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const error = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'failed' } };
    const duplicate = { jsonrpc: '2.0', id: msg.id, result: { content: [{ text: 'must not win' }] } };
    res.write(`data: ${JSON.stringify(error)}\n\ndata: ${JSON.stringify(duplicate)}\n\n`);
  });
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 1000), null);
});

test('matching SSE error fails promptly while the stream remains open', async t => {
  await gateway(t, (msg, req, res) => {
    if (initialize(msg, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'failed' } })}\n\n`);
  });
  const start = Date.now();
  assert.equal(await gw.callCapability({ mode: 'flat' }, 'search', {}, 1000), null);
  assert.ok(Date.now() - start < 500, 'error response waited for the request timeout');
});
