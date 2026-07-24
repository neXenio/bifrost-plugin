import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractUsers, syncOnce } from '../src/sync-vk-map.mjs';

const silent = { info() {}, error() {} };

function fakeFetch(payload, status = 200) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { impl, calls };
}

function tmpMapPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-sync-test-')), 'vk-map.json');
}

test('extractUsers handles common response wrappers and field locations', () => {
  const item = { user: { email: 'Alice@luca-app.de' }, value: 'test-key-alice' };
  for (const payload of [[item], { virtual_keys: [item] }, { data: [item] }, { keys: [item] }]) {
    const { users } = extractUsers(payload);
    assert.deepEqual(users, { 'alice@luca-app.de': 'test-key-alice' });
  }
  // flat user_email / key variant
  const { users } = extractUsers([{ user_email: 'bob@luca-app.de', key: 'test-key-bob' }]);
  assert.deepEqual(users, { 'bob@luca-app.de': 'test-key-bob' });
});

test('extractUsers skips entries without email or value, and inactive keys', () => {
  const { users, skipped, total } = extractUsers([
    { user: { email: 'alice@luca-app.de' }, value: 'test-key-alice' },
    { name: 'team key', value: 'test-key-team' },
    { user: { email: 'bob@luca-app.de' } },
    { user: { email: 'carol@luca-app.de' }, value: 'test-key-carol', is_active: false },
  ]);
  assert.deepEqual(users, { 'alice@luca-app.de': 'test-key-alice' });
  assert.equal(skipped, 3);
  assert.equal(total, 4);
});

test('extractUsers dot-path overrides pin exact fields', () => {
  const { users } = extractUsers(
    { data: [{ owner: { mail: 'dave@luca-app.de' }, secret: { token: 'test-key-dave' } }] },
    { emailPath: 'owner.mail', valuePath: 'secret.token' },
  );
  assert.deepEqual(users, { 'dave@luca-app.de': 'test-key-dave' });
});

test('extractUsers throws on unrecognized shapes', () => {
  assert.throws(() => extractUsers({ nope: true }));
  assert.throws(() => extractUsers('html'));
});

test('syncOnce writes the map, then reports unchanged on identical rerun', async () => {
  const mapPath = tmpMapPath();
  const { impl, calls } = fakeFetch({
    virtual_keys: [{ user: { email: 'alice@luca-app.de' }, value: 'test-key-alice' }],
  });
  const opts = {
    adminUrl: 'http://bifrost.internal/',
    adminToken: 'bfst-test',
    mapPath,
    fetchImpl: impl,
    log: silent,
  };

  const first = await syncOnce(opts);
  assert.deepEqual({ mapped: first.mapped, changed: first.changed }, { mapped: 1, changed: true });
  assert.equal(calls[0].url, 'http://bifrost.internal/api/governance/virtual-keys');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer bfst-test');
  assert.deepEqual(JSON.parse(fs.readFileSync(mapPath, 'utf8')), {
    users: { 'alice@luca-app.de': 'test-key-alice' },
  });

  const second = await syncOnce(opts);
  assert.equal(second.changed, false);
});

test('syncOnce uses a custom auth header when configured', async () => {
  const { impl, calls } = fakeFetch({ virtual_keys: [{ email: 'a@b.c', value: 'k' }] });
  await syncOnce({
    adminUrl: 'http://x',
    adminToken: 'tok',
    authHeaderName: 'x-bf-admin',
    mapPath: tmpMapPath(),
    fetchImpl: impl,
    log: silent,
  });
  assert.equal(calls[0].opts.headers['x-bf-admin'], 'tok');
  assert.equal(calls[0].opts.headers.authorization, undefined);
});

test('syncOnce refuses an empty extraction unless allowEmpty, and keeps the existing map', async () => {
  const mapPath = tmpMapPath();
  fs.writeFileSync(mapPath, JSON.stringify({ users: { 'alice@luca-app.de': 'test-key-alice' } }));

  const { impl } = fakeFetch({ virtual_keys: [{ name: 'team key', value: 'test-key-team' }] });
  const opts = { adminUrl: 'http://x', adminToken: 't', mapPath, fetchImpl: impl, log: silent };

  await assert.rejects(syncOnce(opts), /0 user->VK entries/);
  assert.deepEqual(JSON.parse(fs.readFileSync(mapPath, 'utf8')).users, {
    'alice@luca-app.de': 'test-key-alice',
  });

  const forced = await syncOnce({ ...opts, allowEmpty: true });
  assert.equal(forced.mapped, 0);
});

test('syncOnce surfaces API errors without touching the map', async () => {
  const mapPath = tmpMapPath();
  fs.writeFileSync(mapPath, JSON.stringify({ users: { 'alice@luca-app.de': 'test-key-alice' } }));
  const { impl } = fakeFetch({}, 401);

  await assert.rejects(
    syncOnce({ adminUrl: 'http://x', adminToken: 'bad', mapPath, fetchImpl: impl, log: silent }),
    /401/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(mapPath, 'utf8')).users, {
    'alice@luca-app.de': 'test-key-alice',
  });
});

test('dry-run reports changes without writing', async () => {
  const mapPath = tmpMapPath();
  const { impl } = fakeFetch({ virtual_keys: [{ email: 'a@b.c', value: 'k' }] });
  const res = await syncOnce({
    adminUrl: 'http://x',
    adminToken: 't',
    mapPath,
    dryRun: true,
    fetchImpl: impl,
    log: silent,
  });
  assert.equal(res.changed, true);
  assert.ok(!fs.existsSync(mapPath));
});
