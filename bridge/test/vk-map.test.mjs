import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVkMap } from '../src/vk-map.mjs';

function writeMap(file, users) {
  fs.writeFileSync(file, JSON.stringify({ users }));
}

function tempMapFile(users) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-map-test-'));
  const file = path.join(dir, 'vk-map.json');
  writeMap(file, users);
  return file;
}

test('looks up by verified email first, then sub', (t) => {
  const file = tempMapFile({ 'alice@luca-app.de': 'test-key-alice', 'sub-bob': 'test-key-bob' });
  const map = createVkMap(file);
  t.after(() => map.close());

  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: true, sub: 'sub-alice' }), 'test-key-alice');
  assert.equal(map.lookup({ sub: 'sub-bob' }), 'test-key-bob');
});

test('an unverified email is ignored — falls through to sub, never claims the email key', (t) => {
  const file = tempMapFile({ 'alice@luca-app.de': 'test-key-alice', 'sub-bob': 'test-key-bob' });
  const map = createVkMap(file);
  t.after(() => map.close());

  // email_verified:false → the alice address must NOT resolve; sub wins instead.
  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: false, sub: 'sub-bob' }), 'test-key-bob');
  // No verified email and no mapped sub → hard deny.
  assert.equal(map.lookup({ email: 'alice@luca-app.de' }), null);
  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: false }), null);
});

test('unmapped user returns null (deny-by-default)', (t) => {
  const map = createVkMap(tempMapFile({ 'alice@luca-app.de': 'test-key-alice' }));
  t.after(() => map.close());

  assert.equal(map.lookup({ email: 'mallory@luca-app.de', sub: 'sub-mallory' }), null);
  assert.equal(map.lookup({}), null);
});

test('reload picks up new entries', (t) => {
  const file = tempMapFile({ 'alice@luca-app.de': 'test-key-alice' });
  const map = createVkMap(file);
  t.after(() => map.close());

  writeMap(file, { 'alice@luca-app.de': 'test-key-alice', 'carol@luca-app.de': 'test-key-carol' });
  map.reload();
  assert.equal(map.lookup({ email: 'carol@luca-app.de', email_verified: true }), 'test-key-carol');
  assert.equal(map.size(), 2);
});

test('email lookup is case-insensitive (sync job lowercases keys)', (t) => {
  const map = createVkMap(tempMapFile({ 'Alice@Luca-App.de': 'test-key-alice' }));
  t.after(() => map.close());

  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: true }), 'test-key-alice');
  assert.equal(map.lookup({ email: 'ALICE@LUCA-APP.DE', email_verified: true }), 'test-key-alice');
});

test('atomic rename replacement is picked up by reload (sync job write pattern)', (t) => {
  const file = tempMapFile({ 'alice@luca-app.de': 'test-key-alice' });
  const map = createVkMap(file);
  t.after(() => map.close());

  // Same write pattern as sync-vk-map.mjs: tmp file + rename over the map.
  const tmp = path.join(path.dirname(file), '.vk-map.tmp-test');
  fs.writeFileSync(tmp, JSON.stringify({ users: { 'erin@luca-app.de': 'test-key-erin' } }));
  fs.renameSync(tmp, file);

  map.reload();
  assert.equal(map.lookup({ email: 'erin@luca-app.de', email_verified: true }), 'test-key-erin');
  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: true }), null);
});

test('malformed map at startup throws; malformed reload keeps previous map', (t) => {
  assert.throws(() => createVkMap(tempMapFile(null)));

  const file = tempMapFile({ 'alice@luca-app.de': 'test-key-alice' });
  const map = createVkMap(file);
  t.after(() => map.close());

  fs.writeFileSync(file, 'not json');
  assert.throws(() => map.reload());
  assert.equal(map.lookup({ email: 'alice@luca-app.de', email_verified: true }), 'test-key-alice');
});
