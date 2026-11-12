'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { preparePromptQuery, MAX_PROMPT_CHARS, MAX_QUERY_CHARS } = require('../hooks/lib/prompt-query.cjs');

test('ordinary tasks yield normalized, bounded queries', () => {
  assert.equal(preparePromptQuery('  review\n password validation\t logic  '), 'review password validation logic');
  assert.equal(preparePromptQuery('a'.repeat(1000)).length, MAX_QUERY_CHARS);
});

test('disabled, empty, malformed and oversized inputs are withheld', () => {
  for (const input of ['', '  ', null, {}, 42, 'a'.repeat(MAX_PROMPT_CHARS + 1)]) {
    assert.equal(preparePromptQuery(input), null);
  }
  assert.equal(preparePromptQuery('review this task', { enabled: false }), null);
});

test('representative synthetic credential formats withhold the whole query', () => {
  const fixtures = [
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'Authorization: Bearer synthetic-credential',
    '"Authorization": "fixture-only"', 'AUTH=fixture-only',
    'proxy-authorization = Basic c3ludGhldGljOm9ubHk=',
    'Bearer synthetic-credential',
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.c3ludGhldGlj',
    'password = fixture-only', 'PASSWORD: fixture-only', 'password is fixture-only',
    '"api_key": "fixture-only"', 'access_token=fixture-only', 'client_secret=fixture-only',
    'BIFROST_VK=fixture-only', 'token: fixture-only',
    'x-bf-vk: fixture-only', '"x-bf-vk": "fixture-only"', 'api key: fixture-only',
    'sk-proj-' + 'x'.repeat(24), 'ghp_' + 'x'.repeat(30),
    'github_pat_' + 'x'.repeat(30), 'xoxb-' + '1'.repeat(24),
    'AKIA' + 'A'.repeat(16), 'postgres://fixture:fixture@example.invalid/db',
  ];
  for (let i = 0; i < fixtures.length; i++) {
    assert.equal(preparePromptQuery(`fix this example ${fixtures[i]}`), null, `fixture ${i}`);
  }
});

test('a secret beyond the outgoing query limit still withholds the query', () => {
  assert.equal(preparePromptQuery('review ' + 'a'.repeat(700) + ' password=fixture-only'), null);
});

// Run the actual hook entry point with only the gateway boundary replaced. All
// prompts/credentials here are synthetic; no configured gateway or user cache is used.
function runHook(prompt, overrides = {}, locked = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-query-'));
  const root = path.resolve(__dirname, '..');
  const callsFile = path.join(home, 'calls.jsonl');
  const preload = path.join(home, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const gw = require(${JSON.stringify(path.join(root, 'hooks/lib/gateway.cjs'))});
    const pc = require(${JSON.stringify(path.join(root, 'hooks/lib/plugin-config.cjs'))});
    gw.env = () => ({ url: 'https://fixture.invalid/mcp', vk: 'fixture-only-key' });
    gw.getCapabilities = async () => ({
      skills: { server: 'skills', mode: 'flat' },
      memory: { server: 'memory', mode: 'flat' }
    });
    gw.callCapability = async (_caps, name, args) => {
      fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ name, query: args.query }) + '\\n');
      return null;
    };
    pc.loadCached = () => (${JSON.stringify(locked ? { hooks: { 'prompt-submit': {
      enabled: true, fields: { skillSearch: true, memoryRecall: true },
      lockedFields: ['skillSearch', 'memoryRecall'],
    } } } : null)});
  `);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BIFROST_') || key === 'NODE_OPTIONS') delete env[key];
  }
  Object.assign(env, overrides);
  try {
    const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'hooks/prompt-submit.cjs')], {
      env, input: JSON.stringify({ prompt, session_id: 'synthetic-privacy-test' }),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const calls = fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      : [];
    return { calls, stdout: result.stdout };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('hook sends the same bounded query to both automatic searches', () => {
  const prompt = 'review\n' + 'ordinary task '.repeat(100);
  const result = runHook(prompt);
  assert.deepEqual(result.calls.map(call => call.name), ['skill_search', 'memory_search']);
  assert.equal(result.calls[0].query, preparePromptQuery(prompt));
  assert.equal(result.calls[1].query, result.calls[0].query);
  assert.equal(result.calls[0].query.length, MAX_QUERY_CHARS);
});

test('hook rejects sensitive prompts without calls or prompt-derived suggestions', () => {
  for (const prompt of [
    'review Authorization: Bearer fixture-only-credential',
    'review {"x-bf-vk": "fixture-only"}',
    'review ' + 'a'.repeat(700) + ' password=fixture-only',
    'review ' + 'a'.repeat(MAX_PROMPT_CHARS),
  ]) {
    const result = runHook(prompt);
    assert.deepEqual(result.calls, []);
    assert.equal(result.stdout, '');
  }
});

test('local opt-out prevents both calls even under locked enabled server settings', () => {
  for (const value of ['0', 'false', ' FALSE ']) {
    const result = runHook('review ordinary task', { BIFROST_PROMPT_RECALL: value }, true);
    assert.deepEqual(result.calls, []);
    assert.equal(result.stdout, '');
  }
});

test('existing per-search environment flags retain their behavior', () => {
  assert.deepEqual(runHook('review ordinary task', { BIFROST_PROMPT_SKILLS: '0' }).calls.map(c => c.name), ['memory_search']);
  assert.deepEqual(runHook('review ordinary task', { BIFROST_PROMPT_MEMORY: '0' }).calls.map(c => c.name), ['skill_search']);
  assert.deepEqual(runHook('review ordinary task', {
    BIFROST_PROMPT_SKILLS: '0', BIFROST_PROMPT_MEMORY: '0',
  }).calls, []);
});
