'use strict';
// End-to-end tests of the detached refresh worker and of session-start's spawn of it.
// refresh.cjs runs as a real child process against a loopback HTTP gateway stub, in a
// throwaway HOME and a throwaway git repo, so what is asserted is what a real run does:
// which memory_search calls it makes, what query it sends, and what it writes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REFRESH = path.join(ROOT, 'hooks', 'refresh.cjs');
const SESSION_START = path.join(ROOT, 'hooks', 'session-start.cjs');

const GOOD = { content: 'GOOD-FACT', similarity: 0.9 };
const LEAK = { content: 'SCREENPIPE-LEAK', similarity: 0.95, wing: 'screenpipe' };

// Advertises one skills and one memory tool. Records every tools/call. memory_search
// answers with `reply` (a function of the call, so tests can vary it).
function startGateway(reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (_) {}
      let result = {};
      if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'teamskills-skill_search' }, { name: 'team-memory-memory_search' }] };
      } else if (msg.method === 'tools/call') {
        calls.push({ name: msg.params.name, args: msg.params.arguments });
        const text = msg.params.name.endsWith('memory_search') ? JSON.stringify(reply(msg.params.arguments)) : 'ok';
        result = { content: [{ text }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, url: `http://127.0.0.1:${server.address().port}/mcp`,
    searches: () => calls.filter((c) => c.name.endsWith('memory_search')).map((c) => c.args),
  })));
}

const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'pipe', env: gitEnv });
}

function repo(branch, remote = 'git@gitlab.example.com:grp/my-proj.git') {
  const dir = fs.realpathSync(mk('e2e-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

function cachePathFor(home, proj) {
  const label = path.basename(proj).replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(proj).digest('hex').slice(0, 12);
  return path.join(home, '.cache', 'bifrost-plugin', `inject-${label}-${digest}.json`);
}

function seed(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// Runs `node refresh.cjs <cache> ...args` and resolves with the gateway calls and cache.
async function runRefresh({ proj, args, env = {}, reply = () => [GOOD], prev, home = mk('e2e-home-'), binDir }) {
  const gw = await startGateway(reply);
  const file = cachePathFor(home, proj);
  if (prev) seed(file, prev);
  const penv = {
    ...gitEnv, HOME: home, CLAUDE_PROJECT_DIR: proj, BIFROST_URL: gw.url, BIFROST_VK: 'k',
    BIFROST_PLUGIN_CONFIG: '0', BIFROST_MEMORY_PRIME: '1', BIFROST_KB_WING: '', ...env,
  };
  if (penv.BIFROST_MEMORY_PRIME === undefined) delete penv.BIFROST_MEMORY_PRIME;
  if (binDir) penv.PATH = `${binDir}${path.delimiter}${penv.PATH}`;
  const child = spawn(process.execPath, [REFRESH, file, ...(args || ['--dir', proj])],
    { env: penv, stdio: 'ignore' });
  const code = await new Promise((resolve) => child.on('close', resolve));
  gw.server.close();
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return { code, cache, gw, file, searches: gw.searches() };
}

test('with priming on, one search is sent with the project query and the cache is stamped v2', async () => {
  const proj = repo('LUCA-7-alpha-beta');
  const r = await runRefresh({ proj });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.searches.length, 1);
  assert.strictEqual(r.searches[0].query, 'my-proj LUCA-7 alpha beta');
  assert.strictEqual(r.searches[0].limit, 12);
  assert.strictEqual(r.cache.v, 2);
  assert.ok(Number.isFinite(r.cache.at));
  assert.deepStrictEqual(r.cache.memory.facts.map((f) => f.content), ['GOOD-FACT']);
  assert.strictEqual(r.cache.memory.head, 'ref: refs/heads/LUCA-7-alpha-beta');
  assert.strictEqual(r.cache.memory.skipped, undefined);
  assert.ok(r.cache.skills, 'skills info is still cached');
});

test('--dir is honoured: the repo of that dir is queried, not the worker cwd', async () => {
  const proj = repo('LUCA-8-other');
  const r = await runRefresh({ proj, args: ['--dir', proj] });
  assert.strictEqual(r.searches[0].query, 'my-proj LUCA-8 other');
  assert.notStrictEqual(r.searches[0].query, '--dir');
});

test('the legacy positional query is passed through unchanged', async () => {
  const proj = repo('LUCA-7-alpha');
  const r = await runRefresh({ proj, args: ['explicit query words'] });
  assert.strictEqual(r.searches[0].query, 'explicit query words');
});

test('excluded and unscored rows inside a nested wrapper never reach the cache', async () => {
  const proj = repo('LUCA-7-alpha-beta');
  const r = await runRefresh({ proj, reply: () => ({ data: { results: [LEAK, GOOD, { content: 'UNSCORED' }] } }) });
  assert.deepStrictEqual(r.cache.memory.facts.map((f) => f.content), ['GOOD-FACT']);
});

test('by default no memory_search is made, no git runs, and no facts are cached', async () => {
  const proj = repo('LUCA-7-alpha-beta');
  const bin = mk('e2e-bin-');
  const marker = path.join(bin, 'git-ran');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const r = await runRefresh({
    proj, env: { BIFROST_MEMORY_PRIME: undefined, BIFROST_KB_WING: 'knowledgebase' }, binDir: bin,
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: 'ref: refs/heads/LUCA-7-alpha-beta',
      facts: [{ content: 'OLD-FACT', similarity: 0.9 }] } },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.searches.length, 0, 'memory_search must not be called, KB wing or not');
  assert.ok(!fs.existsSync(marker), 'no git call');
  assert.strictEqual(r.cache.v, 2);
  assert.strictEqual(r.cache.memory.server, 'team-memory');
  assert.deepStrictEqual(r.cache.memory.facts, [], 'old facts are not carried forward');
  assert.strictEqual(r.cache.memory.skipped, 'prime-off');
  assert.strictEqual(r.cache.kb, undefined);
  assert.ok(r.cache.skills);
});

test('BIFROST_MEMORY_PRIME=0 behaves like unset', async () => {
  const r = await runRefresh({ proj: repo('LUCA-7-alpha'), env: { BIFROST_MEMORY_PRIME: '0' } });
  assert.strictEqual(r.searches.length, 0);
});

test('no project signal: zero searches and the skip is recorded', async () => {
  const home = mk('e2e-home-');
  const proj = path.join(home, 'Desktop');
  fs.mkdirSync(proj);
  const r = await runRefresh({
    proj, home,
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: '',
      facts: [{ content: 'OLD-FACT', similarity: 0.9 }] } },
  });
  assert.strictEqual(r.searches.length, 0);
  assert.strictEqual(r.cache.memory.skipped, 'no-signal');
  assert.deepStrictEqual(r.cache.memory.facts, [], 'a deliberate skip does not carry old facts forward');
});

test('KB recall with no signal is skipped too, and with signal is scoped to the wing', async () => {
  const home = mk('e2e-home-');
  const desktop = path.join(home, 'Desktop');
  fs.mkdirSync(desktop);
  const none = await runRefresh({ proj: desktop, home, env: { BIFROST_KB_WING: 'knowledgebase' } });
  assert.strictEqual(none.searches.length, 0);
  assert.strictEqual(none.cache.kb.skipped, 'no-signal');
  assert.deepStrictEqual(none.cache.kb.facts, []);

  const some = await runRefresh({ proj: repo('LUCA-7-alpha'), env: { BIFROST_KB_WING: 'knowledgebase' } });
  assert.strictEqual(some.searches.length, 2);
  assert.deepStrictEqual(some.searches[1].filters, { wing: 'knowledgebase' });
  assert.strictEqual(some.searches[1].query, 'my-proj LUCA-7 alpha');
});

test('a git error is not a skip: the previous facts are carried forward as stale', async () => {
  const home = mk('e2e-home-');
  const proj = path.join(mk('e2e-gone-'), 'missing'); // git cannot start in a missing dir
  const r = await runRefresh({
    proj, home,
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: '',
      facts: [{ content: 'KEPT-FACT', similarity: 0.9 }] } },
  });
  assert.strictEqual(r.searches.length, 0);
  assert.strictEqual(r.cache.memory.skipped, undefined);
  assert.deepStrictEqual(r.cache.memory.facts.map((f) => f.content), ['KEPT-FACT']);
  assert.strictEqual(r.cache.memory.stale, true);
});

test('an empty answer on the same branch carries the previous facts forward as stale', async () => {
  const proj = repo('LUCA-7-alpha');
  const r = await runRefresh({
    proj, reply: () => [],
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: 'ref: refs/heads/LUCA-7-alpha',
      facts: [{ content: 'KEPT-FACT', similarity: 0.9 }] } },
  });
  assert.deepStrictEqual(r.cache.memory.facts.map((f) => f.content), ['KEPT-FACT']);
  assert.strictEqual(r.cache.memory.stale, true);
});

test('an empty answer on another branch does not resurrect the previous branch\'s facts', async () => {
  const proj = repo('LUCA-9-gamma');
  const r = await runRefresh({
    proj, reply: () => [],
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: 'ref: refs/heads/LUCA-7-alpha',
      facts: [{ content: 'OTHER-BRANCH-FACT', similarity: 0.9 }] },
      kb: { server: 'team-memory', head: 'ref: refs/heads/LUCA-7-alpha', facts: [{ content: 'OTHER-KB', similarity: 0.9 }] } },
  });
  assert.deepStrictEqual(r.cache.memory.facts, []);
  assert.ok(!r.cache.kb || !r.cache.kb.facts.length);
});

test('facts from a pre-v2 cache are not carried forward under the v2 stamp', async () => {
  const proj = repo('LUCA-7-alpha');
  const r = await runRefresh({
    proj, reply: () => [],
    prev: { at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: 'ref: refs/heads/LUCA-7-alpha',
      facts: [{ content: 'V1-FACT', similarity: 0.9 }] } },
  });
  assert.strictEqual(r.cache.v, 2);
  assert.deepStrictEqual(r.cache.memory.facts, []);
});

test('the cache is replaced by rename, never rewritten in place', () => {
  const { writeCacheAtomic } = require('../hooks/refresh.cjs');
  const dir = mk('e2e-atomic-');
  const file = path.join(dir, 'sub', 'inject.json');
  writeCacheAtomic(file, '{"a":1}');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
  const alias = path.join(dir, 'alias.json');
  fs.linkSync(file, alias); // a second name for the same inode
  writeCacheAtomic(file, '{"a":2}');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.strictEqual(fs.readFileSync(alias, 'utf8'), '{"a":1}', 'an in-place write would show through the alias');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'sub')), ['inject.json'], 'no temp file left behind');
});

// --- session-start -> refresh.cjs wiring ----------------------------------------------

// A --require preload that records the argv of any refresh.cjs process it is loaded into.
function argvRecorder() {
  const dir = mk('e2e-rec-');
  const out = path.join(dir, 'argv.json');
  const hook = path.join(dir, 'rec.cjs');
  fs.writeFileSync(hook, `if (/refresh\\.cjs$/.test(process.argv[1] || '')) ` +
    `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv));\n`);
  return { out, hook };
}

function startSession({ proj, home, env = {} }) {
  const rec = argvRecorder();
  const r = spawnSync(process.execPath, [SESSION_START], {
    encoding: 'utf8', timeout: 10000,
    env: {
      ...gitEnv, HOME: home, CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'http://127.0.0.1:1/mcp', BIFROST_VK: 'k',
      BIFROST_PLUGIN_CONFIG: '0', NODE_OPTIONS: `--require ${rec.hook}`, ...env,
    },
  });
  return { r, rec };
}

async function spawnedArgv(rec, waitMs) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (fs.existsSync(rec.out)) return JSON.parse(fs.readFileSync(rec.out, 'utf8'));
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

test('session-start spawns refresh.cjs with the cache file, --dir and the project dir', async () => {
  const proj = repo('LUCA-7-alpha');
  const home = mk('e2e-home-');
  const { r, rec } = startSession({ proj, home });
  assert.strictEqual(r.status, 0);
  const argv = await spawnedArgv(rec, 5000);
  assert.ok(argv, 'refresh.cjs was not spawned');
  assert.deepStrictEqual(argv.slice(1), [REFRESH, cachePathFor(home, proj), '--dir', proj]);
});

test('priming on: a branch switch refreshes immediately instead of waiting out the throttle', async () => {
  const proj = repo('LUCA-9-gamma');
  const home = mk('e2e-home-');
  seed(cachePathFor(home, proj), { v: 2, at: Date.now(), memory: { server: 'team-memory', mode: 'flat',
    head: 'ref: refs/heads/LUCA-7-alpha', facts: [{ content: 'OTHER-BRANCH-FACT' }] } });
  const { r, rec } = startSession({ proj, home, env: { BIFROST_MEMORY_PRIME: '1' } });
  assert.ok(!r.stdout.includes('OTHER-BRANCH-FACT'), 'the other branch\'s facts are not rendered');
  assert.ok(await spawnedArgv(rec, 5000), 'a fresh cache with a different HEAD must still refresh');
});

test('priming on, same branch, fresh cache: the hourly throttle holds', async () => {
  const proj = repo('LUCA-7-alpha');
  const home = mk('e2e-home-');
  seed(cachePathFor(home, proj), { v: 2, at: Date.now(), memory: { server: 'team-memory', mode: 'flat',
    head: 'ref: refs/heads/LUCA-7-alpha', facts: [{ content: 'SAME-BRANCH-FACT' }] } });
  const { r, rec } = startSession({ proj, home, env: { BIFROST_MEMORY_PRIME: '1' } });
  assert.ok(r.stdout.includes('SAME-BRANCH-FACT'));
  assert.strictEqual(await spawnedArgv(rec, 800), null);
});

test('priming on over a cache written with priming off refreshes immediately', async () => {
  const proj = repo('LUCA-7-alpha');
  const home = mk('e2e-home-');
  seed(cachePathFor(home, proj), { v: 2, at: Date.now(), memory: { server: 'team-memory', mode: 'flat',
    skipped: 'prime-off', facts: [] } });
  const { rec } = startSession({ proj, home, env: { BIFROST_MEMORY_PRIME: '1' } });
  assert.ok(await spawnedArgv(rec, 5000));
});

test('priming off: a fresh cache is not refreshed early on a branch switch', async () => {
  const proj = repo('LUCA-9-gamma');
  const home = mk('e2e-home-');
  seed(cachePathFor(home, proj), { v: 2, at: Date.now(), memory: { server: 'team-memory', mode: 'flat',
    skipped: 'prime-off', facts: [] } });
  const { rec } = startSession({ proj, home });
  assert.strictEqual(await spawnedArgv(rec, 800), null);
});

test('a hanging git is cut off after a couple of seconds and the cached facts survive', async () => {
  const proj = repo('LUCA-7-alpha');
  const bin = mk('e2e-bin-');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = await runRefresh({
    proj, binDir: bin,
    prev: { v: 2, at: Date.now() - 1000, memory: { server: 'team-memory', mode: 'flat', head: 'ref: refs/heads/LUCA-7-alpha',
      facts: [{ content: 'KEPT-FACT', similarity: 0.9 }] } },
  });
  assert.ok(Date.now() - t0 < 20000, `refresh took ${Date.now() - t0} ms with a hanging git`);
  assert.strictEqual(r.searches.length, 0);
  assert.strictEqual(r.cache.memory.skipped, undefined);
});
