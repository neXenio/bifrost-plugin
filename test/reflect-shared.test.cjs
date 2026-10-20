'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-reflect-'));
const r = require('../hooks/session-reflect.cjs');
const caps = { memory: { server: 'lucamemory', mode: 'flat', tool: 'lucamemory-memory_search' } };

test('default keeps candidates local', () => {
  const t = r.reflection(caps, 1, '/p/.bifrost/candidates.md');
  assert.match(t, /This is a local file, NOT/);
  assert.ok(!/store it with/.test(t));
});

test('memoryStore knob sends verified facts to memory_store, unsure ones to the spool', () => {
  const t = r.reflection(caps, 1, '/p/.bifrost/candidates.md', true);
  assert.match(t, /store it with `[^`]*memory_store`/);
  assert.match(t, /supersedes/);
  assert.match(t, /never secrets/);
  assert.match(t, /candidates\.md` instead/);
  assert.match(r.reflection(caps, 2, '/p/c.md', true), /storing with/);
});
