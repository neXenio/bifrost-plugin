import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.mjs';
import { makeTestKeys, signToken, ISSUER, ORIGIN } from './helpers.mjs';

const { privateKey, jwks } = await makeTestKeys();

// Upstream Bifrost stub: records the last request's headers, answers 200.
const seen = {};
const upstream = http.createServer((req, res) => {
  seen.url = req.url;
  seen.headers = req.headers;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const vkMapPath = path.join(mapDir, 'vk-map.json');
fs.writeFileSync(vkMapPath, JSON.stringify({ users: { 'alice@luca-app.de': 'test-key-alice' } }));

const app = buildServer(
  {
    publicOrigin: ORIGIN,
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`,
    keycloakIssuer: ISSUER,
    requiredScope: 'mcp:read',
    vkMapPath,
    logLevel: 'silent',
  },
  { jwks },
);
await app.ready();

test.after(async () => {
  await app.close();
  upstream.close();
});

const MCP_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

function postMcp(headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    payload: MCP_BODY,
  });
}

test('unauthenticated /mcp returns 401 with resource_metadata pointer', async () => {
  const res = await postMcp();
  assert.equal(res.statusCode, 401);
  assert.equal(
    res.headers['www-authenticate'],
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
  );
});

test('protected resource metadata is served (both well-known paths)', async () => {
  for (const url of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.resource, ORIGIN);
    assert.deepEqual(body.authorization_servers, [ISSUER]);
    assert.deepEqual(body.scopes_supported, ['mcp:read', 'mcp:write']);
  }
});

test('x-bf-vk passthrough forwards unchanged (CLI regression)', async () => {
  const res = await postMcp({ 'x-bf-vk': 'test-key-cli' });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.headers['x-bf-vk'], 'test-key-cli');
});

test('valid Bearer maps to x-bf-vk and strips Authorization', async () => {
  const token = await signToken(privateKey);
  const res = await postMcp({ authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.headers['x-bf-vk'], 'test-key-alice');
  assert.equal(seen.headers.authorization, undefined);
});

test('invalid Bearer returns 401 with error="invalid_token"', async () => {
  const token = await signToken(privateKey, { audience: 'https://other.example.test' });
  const res = await postMcp({ authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /error="invalid_token"/);
});

test('missing scope returns 403 with error="insufficient_scope"', async () => {
  const token = await signToken(privateKey, { scope: 'openid' });
  const res = await postMcp({ authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 403);
  assert.match(res.headers['www-authenticate'], /error="insufficient_scope"/);
});

test('authenticated but unmapped user is denied (deny-by-default)', async () => {
  const token = await signToken(privateKey, { email: 'mallory@luca-app.de', sub: 'sub-mallory' });
  const res = await postMcp({ authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'no_virtual_key');
});

test('healthz responds without auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('non-mcp paths proxy without auth requirements', async () => {
  const res = await app.inject({ method: 'GET', url: '/some/other/path' });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.url, '/some/other/path');
});
