'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeKey } = require('../hooks/lib/cache-scope.cjs');

test('cache identity separates full endpoints and credentials without exposing either', () => {
  const base = 'https://gateway.example/mcp?tenant=one';
  const key = 'synthetic-private-key';
  const id = scopeKey(base, key);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(scopeKey(base, key), id);
  assert.equal(scopeKey('https://GATEWAY.example:443/mcp?tenant=one', key), id);
  for (const [endpoint, credential] of [
    ['https://gateway.example/other?tenant=one', key],
    ['https://gateway.example/mcp?tenant=two', key],
    [base, 'another-private-key'],
  ]) assert.notEqual(scopeKey(endpoint, credential), id);
  assert.equal(id.includes(key), false);
  assert.equal(id.includes('gateway'), false);
});

test('missing or invalid identity cannot address a private cache', () => {
  for (const [endpoint, key] of [
    ['', 'key'], ['not a URL', 'key'], ['file:///private/path', 'key'],
    ['https://gateway.example/mcp', ''], ['https://gateway.example/mcp', '   '],
    [null, 'key'], ['https://gateway.example/mcp', null],
  ]) assert.equal(scopeKey(endpoint, key), null);
});
