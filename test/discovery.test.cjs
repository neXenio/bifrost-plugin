'use strict';
// Regression tests for the discovery/injection path. Every case here is a defect that
// shipped silently: the hooks failed closed, exited 0, and printed nothing, so none of
// them was observable without reading the cache by hand.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const gw = require('../hooks/lib/gateway.cjs');
const { parseStructured, budgetFill } = require('../hooks/refresh.cjs');

// This plugin's own repo is also a real working project: a genuine Claude Code
// session running here legitimately creates `.bifrost/candidates.md` via the session
// hooks. That is correct behaviour, not pollution, and `.bifrost/.gitignore` (`*`)
// keeps git clean regardless. So the "suite never writes into the plugin repository
// itself" guard below can't assert absence — it has to detect that THE SUITE created
// or modified these paths. Snapshot what is there before any test runs (module load
// happens synchronously, before node:test executes the first registered test — see
// the guard test itself for the invariant this depends on).
function snapshotRepoStatePath(full) {
  let st;
  try { st = fs.statSync(full); } catch (_) { return { exists: false }; }
  if (!st.isDirectory()) return { exists: true, isDir: false, mtimeMs: st.mtimeMs };
  const entries = new Map();
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const relPath = rel ? path.join(rel, name) : name;
      const s = fs.statSync(abs);
      if (s.isDirectory()) walk(abs, relPath);
      else entries.set(relPath, s.mtimeMs);
    }
  })(full, '');
  return { exists: true, isDir: true, entries };
}
// The watched set is derived from what the code actually writes, not from what a stray
// file would plausibly be called. Every write target in hooks/ is one of two shapes:
//
//   ~/.cache/bifrost-plugin/**        usage.json, discovery.json, inject-*.json, the
//                                     reflect markers, the plugin-config cache
//   <projectDir>/.bifrost/**          candidates.md and its .gitignore
//
// So the two ways a hook lands inside this repository are HOME pointing here (which
// gives ROOT/.cache/…, NOT ROOT/usage.json) and cwd/CLAUDE_PROJECT_DIR pointing here
// (which gives ROOT/.bifrost/…, NOT ROOT/candidates.md). The earlier set watched the
// two bare root filenames, which no code path can produce under either confusion — it
// read as broader coverage than it had, and the HOME case it was written to commemorate
// went unwatched. `.claude` is the one entry not derived from a plugin write: nothing in
// hooks/ creates it, but a suite that ever shells out to a real `claude` binary would
// get ROOT/.claude/settings.local.json, and that is the same class of accident.
//
// LIMITATION, stated so nobody over-trusts this: `npm test` runs each test FILE in its
// own process, in parallel. This guard only sees writes made by THIS process and by the
// hooks THIS file spawns. compat.test.cjs spawns real hooks with cwd = the repo root
// and, at several call sites, no CLAUDE_PROJECT_DIR — so the process.cwd() fallback
// applies there. A write from that sibling process is invisible here, and one landing
// before this file's module load is snapshotted as pre-existing and passes silently.
// Not a live problem (a clean checkout has no .bifrost and `git status` stays clean),
// and worth neither serializing the suite nor a lock file — but the guard proves less
// than "the suite wrote nothing", and its failure is the only signal, never its pass.
const REPO_STATE_GUARD = ['.bifrost', '.cache', '.claude'].map((stray) => {
  const full = path.join(ROOT, stray);
  return { stray, full, before: snapshotRepoStatePath(full) };
});

// --- Group 1: flat tool name -> server derivation -------------------------------
// Driven through the REAL discover() against a loopback MCP stub. An earlier version
// of these tests re-implemented the derivation inside the test file, so reverting the
// production fix left the whole suite green.

const http = require('http');

// Minimal MCP gateway: answers initialize and tools/list, and echoes back the name of
// any tools/call so a test can assert which tool the client actually invoked.
function startStubGateway(toolNames, catalog) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (_) {}
      let result = {};
      if (msg.method === 'tools/list') {
        result = { tools: toolNames.map((name) => ({ name })) };
      } else if (msg.method === 'tools/call') {
        calls.push(msg.params && msg.params.name);
        const isCatalog = msg.params && msg.params.name === 'listToolFiles';
        result = { content: [{ text: isCatalog && catalog ? catalog : 'ok' }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

async function discoverAgainst(toolNames, catalog) {
  const stub = await startStubGateway(toolNames, catalog);
  const prevUrl = process.env.BIFROST_URL;
  const prevVk = process.env.BIFROST_VK;
  process.env.BIFROST_URL = stub.url;   // loopback http is permitted by design
  process.env.BIFROST_VK = 'test-key';
  try {
    const disc = await gw.discover(4000);
    return { disc, stub };
  } finally {
    if (prevUrl === undefined) delete process.env.BIFROST_URL; else process.env.BIFROST_URL = prevUrl;
    if (prevVk === undefined) delete process.env.BIFROST_VK; else process.env.BIFROST_VK = prevVk;
    stub.server.close();
  }
}

test('a hyphenated SERVER name resolves correctly', async () => {
  const { disc } = await discoverAgainst(['team-memory-memory_search']);
  assert.strictEqual(disc.memory.server, 'team-memory');
  assert.strictEqual(disc.memory.tool, 'team-memory-memory_search');
});

test('a hyphenated TOOL name resolves correctly', async () => {
  // The fallback patterns accept skill-search / memory-search, so the boundary cannot
  // be found by splitting on the last hyphen either.
  const { disc } = await discoverAgainst(['skills-skill-search']);
  assert.strictEqual(disc.skills.server, 'skills');
  assert.strictEqual(disc.skills.tool, 'skills-skill-search');
});

test('the discovered tool is called by its advertised name, verbatim', async () => {
  for (const advertised of [
    'teamskills-skill_search',
    'team-memory-memory_search',
    'skills-skill-search',
  ]) {
    const stub = await startStubGateway([advertised]);
    const prevUrl = process.env.BIFROST_URL;
    const prevVk = process.env.BIFROST_VK;
    process.env.BIFROST_URL = stub.url;
    process.env.BIFROST_VK = 'test-key';
    try {
      const disc = await gw.discover(4000);
      const cap = disc.skills || disc.memory;
      const fn = /skill/.test(advertised) ? 'skill_search' : 'memory_search';
      await gw.callCapability(cap, fn, {}, 4000);
      assert.ok(
        stub.calls.includes(advertised),
        `called ${JSON.stringify(stub.calls)}, gateway advertises "${advertised}"`
      );
    } finally {
      if (prevUrl === undefined) delete process.env.BIFROST_URL; else process.env.BIFROST_URL = prevUrl;
      if (prevVk === undefined) delete process.env.BIFROST_VK; else process.env.BIFROST_VK = prevVk;
      stub.server.close();
    }
  }
});

test('sibling tools are built from the server prefix', () => {
  const cap = { server: 'team-memory', mode: 'flat', tool: 'team-memory-memory_search' };
  assert.strictEqual(gw.flatToolName(cap, 'memory_search'), 'team-memory-memory_search');
  assert.strictEqual(gw.flatToolName(cap, 'memory_store'), 'team-memory-memory_store');
});

// --- Group 2: credential resolution ----------------------------------------------
// Hook processes do not inherit Claude Code's MCP credential. Installing with
// `claude mcp add` writes it to ~/.claude.json, never to the environment, so an
// env-only lookup returned empty and the whole hook layer went inert.

test('env vars win when both are present', () => {
  const prevUrl = process.env.BIFROST_URL;
  const prevVk = process.env.BIFROST_VK;
  process.env.BIFROST_URL = 'https://example.test/mcp';
  process.env.BIFROST_VK = 'env-key';
  try {
    const e = gw.env();
    assert.strictEqual(e.url, 'https://example.test/mcp');
    assert.strictEqual(e.vk, 'env-key');
  } finally {
    if (prevUrl === undefined) delete process.env.BIFROST_URL; else process.env.BIFROST_URL = prevUrl;
    if (prevVk === undefined) delete process.env.BIFROST_VK; else process.env.BIFROST_VK = prevVk;
  }
});

test('credentialFromMcpConfig is exported and never throws', () => {
  assert.strictEqual(typeof gw.credentialFromMcpConfig, 'function');
  assert.doesNotThrow(() => gw.credentialFromMcpConfig());
});

test('unexpanded ${VAR} placeholders are not treated as credentials', () => {
  // The plugin's own bundled .mcp.json ships literal ${BIFROST_URL}/${BIFROST_VK}.
  // Accepting those would produce a a nonsense URL and a fake key.
  const UNEXPANDED_RE = /\$\{[^}]*\}/;
  assert.ok(UNEXPANDED_RE.test('${BIFROST_VK}'));
  assert.ok(UNEXPANDED_RE.test('${BIFROST_URL}'));
  assert.ok(!UNEXPANDED_RE.test('https://bifrost.example.com/mcp'));
});

// --- Group 3: relevance threshold -------------------------------------------------
// The old default floor (0.45) sat entirely above this gateway's measured score range
// (0.381-0.415), so every scored fact was dropped and the memory section rendered
// empty on every session. Scores are not comparable across servers, so there is no
// safe non-zero default.

test('facts scoring in the live-measured range are kept, not dropped', () => {
  const live = [
    { content: 'fact A', similarity: 0.415 },
    { content: 'fact B', similarity: 0.400 },
    { content: 'fact C', similarity: 0.381 },
  ];
  const kept = budgetFill(live);
  assert.strictEqual(kept.length, 3, 'default floor must not discard mid-range scores');
});

test('higher-scored facts rank first', () => {
  const kept = budgetFill([
    { content: 'low', similarity: 0.20 },
    { content: 'high', similarity: 0.90 },
  ]);
  assert.strictEqual(kept[0].content, 'high');
});

test('unscored facts (legacy response shape) are still kept', () => {
  const kept = budgetFill([
    { content: 'a', similarity: null },
    { content: 'b', similarity: null },
  ]);
  assert.strictEqual(kept.length, 2);
});

// --- Group 4: per-project cache key ------------------------------------------------
// Keying on the bare basename meant ~/work-a/backend and ~/work-b/backend
// shared one file, so one project's facts were injected into the other's session.

// Drives the REAL cacheFile() exported by the hook. A local re-implementation would
// keep passing if the hook reverted to basename-only keying.
const sessionStart = require('../hooks/session-start.cjs');

function cacheFileUsedBy(projDir) {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projDir;
  try { return sessionStart.cacheFile(); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
  }
}

test('same basename in different trees does not collide', () => {
  const a = cacheFileUsedBy('/tmp/tree-one/backend');
  const b = cacheFileUsedBy('/tmp/tree-two/backend');
  assert.ok(a && b, `hook did not read a cache file (a=${a}, b=${b})`);
  assert.notStrictEqual(a, b, 'distinct project paths must map to distinct cache files');
});

test('the same path is stable across runs', () => {
  assert.strictEqual(cacheFileUsedBy('/tmp/tree-one/backend'), cacheFileUsedBy('/tmp/tree-one/backend'));
});

// --- Group 5: roster capture -------------------------------------------------------
// discover() built a complete code-mode catalog and returned only two regex hits, and
// only walked the catalog at all when a capability was missing. On a gateway where
// skills and memory are both flat, the entire code-mode surface (251 tools across 13
// servers on the live gateway) was never even fetched.

test('discovery cache read is synchronous and never throws', () => {
  assert.strictEqual(typeof gw.readDiscoveryCacheSync, 'function');
  assert.doesNotThrow(() => gw.readDiscoveryCacheSync());
});

// Previously two source-text greps: one asserted a guard regex was absent (which a
// harmless operand reorder would defeat) and one pinned the literal text of a return
// statement (which a key reorder would break and an always-empty roster would pass).
// Both are replaced by the invariant they were standing in for, driven through the
// real discover() against a stub that serves a catalog.
const STUB_CATALOG = [
  'servers/',
  '  gitlab/',
  '    create_issue.pyi',
  '    search_issues.pyi',
  '  grafana/',
  '    query_metrics.pyi',
].join('\n');

test('the code-mode catalog is walked even when both capabilities are flat', async () => {
  // The old guard only walked the catalog when skills or memory was missing, so on a
  // gateway where both are flat — the common case — the entire code-mode surface was
  // never fetched.
  const { disc } = await discoverAgainst(
    ['teamskills-skill_search', 'teammemory-memory_search', 'listToolFiles'],
    STUB_CATALOG
  );
  assert.ok(disc.skills && disc.memory, 'both capabilities resolve flat');
  assert.ok(disc.roster, 'discover() must return a roster');
  assert.deepStrictEqual(Object.keys(disc.roster).sort(), ['gitlab', 'grafana']);
  assert.deepStrictEqual(disc.roster.gitlab, ['create_issue', 'search_issues']);
});

test('a gateway with no catalog yields an empty roster, not a crash', async () => {
  const { disc } = await discoverAgainst(['teamskills-skill_search', 'teammemory-memory_search']);
  assert.ok(disc.roster && Object.keys(disc.roster).length === 0);
});

// --- Group 6: no fabricated tool names ---------------------------------------------
// prompt-submit used to fall back to a guessed `mcp__bifrost__skills-skill_search`.
// On a gateway whose skills server is code-mode or named anything else, that is a
// tool that does not exist — taught to the model on the first session.

// Behaviour is covered by 'no discovery cache means no nudge at all', which spawns the
// hook with an empty cache and asserts silence. Grepping the source for the absence of
// an env var name proved nothing the spawn does not prove better.

// --- Group 7: code-mode invocation is executable ------------------------------------
// session-start rendered code-mode as `executeToolCode → server.tool(...)`, omitting
// the `result =` assignment the gateway requires, while prompt-submit got it right.
// Two hooks in one plugin taught two different forms; one of them returns nothing.

test('session-start renders an executable code-mode invocation', () => {
  // Was a source grep for `result =`. Now runs the hook against a code-mode gateway:
  // omitting the assignment produces a call that silently returns nothing, which is
  // the failure this guards and which only the rendered output can show.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-code-'));
  seedCache(home, proj, {
    skills: { server: 'teamskills', mode: 'code' },
    memory: { server: 'teammemory', mode: 'code', total: 5, facts: [] },
  });
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
  }, home);
  assert.strictEqual(r.status, 0);
  for (const line of r.stdout.split('\n')) {
    if (!/executeToolCode/.test(line) || !/teamskills|teammemory/.test(line)) continue;
    assert.match(line, /result = /, `code-mode call must assign result: ${line.trim()}`);
  }
  assert.match(r.stdout, /result = teamskills\.skill_search/);
  assert.match(r.stdout, /result = teammemory\.memory_store/);
});

// --- Group 8: injected memory is fenced as data -------------------------------------
// Recalled facts go to the same stdout stream as the plugin's own instructions. Without
// an explicit boundary a stored fact shaped like an instruction reads as one.

// Behaviour is covered by 'recalled facts are printed inside the untrusted-data fence',
// which asserts the fact sits BETWEEN the open and close markers in real output — a
// source grep passes even if the markers are emitted in the wrong order.

// --- Group 9: placeholders are resolved ----------------------------------------------
// emitContext was a raw readFileSync, so every session printed the literal text
// ${BIFROST_URL} into the model's context.

// Behaviour is covered by 'the virtual key is never written to stdout', which runs the
// hook with a sentinel key and asserts the key is absent while the host is present.

// --- Behaviour tests: run the hook, assert on what it actually prints -------------------
// The groups above pin structural facts; these exercise the real code path end to end
// with fixture caches, so they fail if the feature breaks rather than if the wording
// changes.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-home-'));
}

function runSessionStart(env, home) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.cjs')], {
    env: { ...process.env, HOME: home, BIFROST_URL: '', BIFROST_VK: '', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function seedCache(home, projDir, payload) {
  const label = path.basename(projDir).replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(projDir).digest('hex').slice(0, 12);
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `inject-${label}-${digest}.json`),
    JSON.stringify(Object.assign({ at: Date.now() }, payload))
  );
  return dir;
}

test('the tool roster is rendered from the discovery cache', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(),
    skills: null,
    memory: null,
    roster: { tracker: ['a', 'b', 'c'], metrics: ['x'] },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /4 tools across 2 servers/);
  assert.match(r.stdout, /\*\*tracker\*\* \(3\)/);
  assert.match(r.stdout, /\*\*metrics\*\* \(1\)/);
});

test('the roster names actual tools, not just counts', () => {
  // Server names alone do not convey purpose ("spinach", "clarity"); the tool names
  // are already in the cache, so surfacing them costs nothing extra.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(),
    skills: null,
    memory: null,
    roster: { tracker: ['create_issue', 'search_issues', 'add_comment'] },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /create_issue/);
  assert.match(r.stdout, /search_issues/);
});

test('a long tool list is truncated but keeps the true count', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  const many = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(), skills: null, memory: null, roster: { big: many },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\*\*big\*\* \(30\)/, 'the full count must still be shown');
  assert.ok(!r.stdout.includes('tool_29'), 'the sample must be truncated');
});

test('the code-mode workflow names the correct readToolFile parameter', () => {
  // `path=` fails with "fileName parameter is required"; teaching the wrong spelling
  // costs a wasted round trip on first use.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(), skills: null, memory: null, roster: { tracker: ['a'] },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.match(r.stdout, /readToolFile\(fileName=/);
  assert.match(r.stdout, /result = /, 'the required result assignment must be shown');
});

test('an empty roster prints no tool section at all', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  fs.writeFileSync(path.join(dir, 'discovery.json'),
    JSON.stringify({ at: Date.now(), skills: null, memory: null, roster: {} }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /Bifrost MCP tools/);
});

test('recalled facts are printed inside the untrusted-data fence', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {
    memory: { server: 'teammemory', mode: 'flat', total: 42, facts: [{ content: 'SENTINEL-FACT' }] },
  });
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  const open = r.stdout.indexOf('<untrusted-reference-data');
  const fact = r.stdout.indexOf('SENTINEL-FACT');
  const close = r.stdout.indexOf('</untrusted-reference-data>');
  assert.ok(open !== -1 && close !== -1, 'fence must be present when facts are injected');
  assert.ok(open < fact && fact < close, 'the fact must sit INSIDE the fence');
});

test('structured memory provenance is readable in the injected fact', () => {
  const parsed = parseStructured(JSON.stringify([
    {
      fact: 'The gateway catalog is captured at process start.',
      authority: 0.61,
      provenance: {
        subject: 'Bifrost gateway',
        wing: 'team',
        room: 'architecture',
        created_at: '2026-08-03T18:46:25Z',
        tags: 'not-injected',
      },
    },
    { _system_warnings: [{ type: 'stale_memories', count: 1 }] },
  ]));
  assert.strictEqual(parsed.length, 1, 'system warning elements are not facts');
  assert.strictEqual(parsed[0].similarity, 0.61, 'authority is the structured score');

  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {
    memory: { server: 'teammemory', mode: 'flat', facts: parsed },
  });
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout,
    /Provenance: subject=Bifrost gateway, wing=team, room=architecture, created_at=2026-08-03T18:46:25Z/);
  assert.doesNotMatch(r.stdout, /\[object Object\]|not-injected/);
});

test('carried-over facts are announced as stale', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {
    memory: { server: 'teammemory', mode: 'flat', stale: true, facts: [{ content: 'OLD-FACT' }] },
  });
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /last refresh returned nothing/);
});

test('fresh facts are NOT announced as stale', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {
    memory: { server: 'teammemory', mode: 'flat', facts: [{ content: 'NEW-FACT' }] },
  });
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /last refresh returned nothing/);
});

test('the virtual key is never written to stdout', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {});
  const secret = 'vk_SUPER_SECRET_SENTINEL_VALUE';
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj,
    BIFROST_URL: 'https://gateway.example.test/mcp',
    BIFROST_VK: secret,
  }, home);
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes(secret), 'the key must never reach the model context');
  assert.match(r.stdout, /\(configured\)/);
  assert.match(r.stdout, /gateway\.example\.test/);
});

test('an unconfigured install says so instead of looking healthy', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  // No cache, no env credential, and a HOME with no ~/.claude.json to fall back to.
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /not configured for hooks/);
});

test('session start stays fast with no gateway reachable', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  seedCache(home, proj, {});
  const t0 = Date.now();
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj,
    BIFROST_URL: 'https://127.0.0.1:9/mcp',
    BIFROST_VK: 'x',
  }, home);
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 0);
  // hooks.json allows 5s. The hook must never approach that, dead gateway or not.
  assert.ok(elapsed < 2000, `session start took ${elapsed}ms with a dead gateway`);
});

// --- Group 10: failure is visible ------------------------------------------------------
// The plugin had never authenticated on the author's machine for 27 days and looked
// identical to a healthy install, because the static guidance still printed.

// Behaviour is covered by 'an unconfigured install says so instead of looking healthy'
// and 'the staleness notice names what was actually skipped', both of which run the
// hook. Asserting a function name appears in the file proved only that it was defined.

// --- Credential atomicity ---------------------------------------------------------
// A gateway URL and the key that authenticates to it are one credential. Resolving
// them independently let a stale `export BIFROST_URL=…` pair with the key from
// ~/.claude.json and ship that key to a host it was never issued for. Run in a child
// process: the config lookup is memoized per process.

function resolveEnvIn(home, env) {
  const r = spawnSync(process.execPath, ['-e', `
    const gw = require(${JSON.stringify(path.join(ROOT, 'hooks', 'lib', 'gateway.cjs'))});
    process.stdout.write(JSON.stringify(gw.env()));
  `], { env: { ...process.env, HOME: home, ...env }, encoding: 'utf8', timeout: 10000 });
  try { return JSON.parse(r.stdout); } catch (_) { return null; }
}

function homeWithConfig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-cfg-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      bifrost: { type: 'http', url: 'https://real-gateway.example/mcp', headers: { 'x-bf-vk': 'VK-REAL' } },
    },
  }));
  return home;
}

test('a lone BIFROST_URL never borrows the key from the MCP config', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: 'https://attacker-controlled.example/mcp',
    BIFROST_VK: '',
  });
  assert.ok(got, 'env() should have resolved');
  assert.notStrictEqual(
    got.url, 'https://attacker-controlled.example/mcp',
    'the env-supplied host must not be paired with the config-supplied key'
  );
  if (got.vk) {
    assert.strictEqual(got.url, 'https://real-gateway.example/mcp',
      'a key may only ever be sent to the URL it was configured with');
  }
});

test('the config credential is taken as a pair when the environment is empty', () => {
  const got = resolveEnvIn(homeWithConfig(), { BIFROST_URL: '', BIFROST_VK: '' });
  assert.deepStrictEqual(got, { url: 'https://real-gateway.example/mcp', vk: 'VK-REAL' });
});

test('a complete environment credential is used as-is', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: 'https://env-gateway.example/mcp',
    BIFROST_VK: 'VK-ENV',
  });
  assert.deepStrictEqual(got, { url: 'https://env-gateway.example/mcp', vk: 'VK-ENV' });
});

test('this project\'s own server beats an unrelated project\'s', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-cfg-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: {
      '/somewhere/unrelated': {
        mcpServers: { bifrost: { url: 'https://wrong.example/mcp', headers: { 'x-bf-vk': 'VK-WRONG' } } },
      },
      '/my/project': {
        mcpServers: { bifrost: { url: 'https://right.example/mcp', headers: { 'x-bf-vk': 'VK-RIGHT' } } },
      },
    },
  }));
  const got = resolveEnvIn(home, { BIFROST_URL: '', BIFROST_VK: '', CLAUDE_PROJECT_DIR: '/my/project' });
  assert.strictEqual(got.vk, 'VK-RIGHT');
});

// Since 1.5.0 there is a third credential source, checked between the environment pair
// and the MCP config scan: CLAUDE_PLUGIN_OPTION_GATEWAY_URL / CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY,
// which is how Claude exposes plugin.json's userConfig values to hook processes (see
// gateway.cjs env()). The same atomicity rule applies to it: both halves from this
// source, or neither — a lone option must never pair with a credential half pulled
// from a different source.

test('the environment pair still wins over CLAUDE_PLUGIN_OPTION_* and the MCP config', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: 'https://env-gateway.example/mcp',
    BIFROST_VK: 'VK-ENV',
    CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://plugin-option.example/mcp',
    CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'VK-OPTION',
  });
  assert.deepStrictEqual(got, { url: 'https://env-gateway.example/mcp', vk: 'VK-ENV' });
});

test('the CLAUDE_PLUGIN_OPTION_* pair is used when the environment pair is absent', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: '',
    BIFROST_VK: '',
    CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://plugin-option.example/mcp',
    CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'VK-OPTION',
  });
  // Also proves this source is checked BEFORE the MCP config scan: homeWithConfig()
  // seeds a real, resolvable ~/.claude.json pair that would win if the option pair
  // were skipped instead of preferred.
  assert.deepStrictEqual(got, { url: 'https://plugin-option.example/mcp', vk: 'VK-OPTION' });
});

test('a lone CLAUDE_PLUGIN_OPTION_GATEWAY_URL with no key does not produce a half credential', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: '',
    BIFROST_VK: '',
    CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'https://plugin-option.example/mcp',
    CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: '',
  });
  assert.notStrictEqual(got.url, 'https://plugin-option.example/mcp',
    'a lone gateway_url option must not be returned without its key');
  assert.deepStrictEqual(got, { url: 'https://real-gateway.example/mcp', vk: 'VK-REAL' },
    'falls through to the next credential source (the MCP config pair)');
});

test('a lone BIFROST_URL does not pair with a CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY from the other source', () => {
  const got = resolveEnvIn(homeWithConfig(), {
    BIFROST_URL: 'https://attacker-controlled.example/mcp',
    BIFROST_VK: '',
    CLAUDE_PLUGIN_OPTION_GATEWAY_URL: '',
    CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: 'VK-OPTION',
  });
  assert.notStrictEqual(got.url, 'https://attacker-controlled.example/mcp',
    'the env-supplied host must not be paired with a key from CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY');
  assert.notStrictEqual(got.vk, 'VK-OPTION',
    'the option-supplied key must not be paired with a loose env url');
  assert.deepStrictEqual(got, { url: 'https://real-gateway.example/mcp', vk: 'VK-REAL' },
    'falls through to the next credential source (the MCP config pair)');
});

// --- URL sanitization --------------------------------------------------------------
// An MCP endpoint may legitimately embed credentials. Everything emitted lands in the
// model's context, so masking the key while echoing a URL that contains one is moot.

test('embedded credentials are stripped from the printed gateway URL', () => {
  const out = sessionStart.safeUrl('https://svc:SUPERSECRET@gw.example/mcp?apikey=LEAKME');
  assert.ok(!out.includes('SUPERSECRET'), `userinfo leaked: ${out}`);
  assert.ok(!out.includes('LEAKME'), `query string leaked: ${out}`);
  assert.strictEqual(out, 'https://gw.example/mcp');
});

test('a malformed URL cannot break out of the markdown code span', () => {
  assert.ok(!sessionStart.safeUrl('https://h/`x`').includes('`'));
  assert.strictEqual(sessionStart.safeUrl('not a url'), '(invalid URL)');
  assert.strictEqual(sessionStart.safeUrl(''), '(not configured)');
});

// --- Carry-forward bounds ----------------------------------------------------------
// A degraded response must not blank a good cache. But "degraded" and "deliberately
// empty" look identical, so the carry-forward has to be bounded, must not resurrect a
// capability that no longer exists, and must not refresh the timestamp — otherwise the
// staleness notice it was paired with can never fire.

const { mergeWithPrevious, MAX_CARRY_FORWARD_MS } = require('../hooks/refresh.cjs');

test('an empty response does not blank good cached facts', () => {
  const out = { at: 2000, memory: { server: 'm', facts: [] } };
  mergeWithPrevious(out, { at: 1000, memory: { server: 'm', facts: [{ content: 'KEEP' }] } }, 2000);
  assert.strictEqual(out.memory.facts.length, 1);
  assert.strictEqual(out.memory.stale, true);
});

test('a revoked capability is NOT resurrected', () => {
  // caps.memory absent this run => the key no longer has memory access.
  const out = { at: 2000 };
  mergeWithPrevious(out, { at: 1000, memory: { server: 'm', facts: [{ content: 'REVOKED' }] } }, 2000);
  assert.ok(!out.memory, 'facts for a capability the key lost must not be injected');
});

test('a disabled KB wing is NOT resurrected', () => {
  const out = { at: 2000, memory: { server: 'm', facts: [{ content: 'fresh' }] } };
  mergeWithPrevious(out, { at: 1000, kb: { server: 'm', facts: [{ content: 'OLD KB' }] } }, 2000);
  assert.ok(!out.kb, 'KB facts must not survive the wing being switched off');
});

test('carry-forward expires instead of serving day-one facts forever', () => {
  const t0 = 1_000_000;
  const out = { at: t0, memory: { server: 'm', facts: [] } };
  const prev = { at: t0, memory: { server: 'm', facts: [{ content: 'OLD' }], staleSince: t0 } };
  mergeWithPrevious(out, prev, t0 + MAX_CARRY_FORWARD_MS + 1);
  assert.strictEqual(out.memory.facts.length, 0, 'facts must lapse past the ceiling');
});

test('carried-over content does not refresh the cache timestamp', () => {
  const out = { at: 9999, memory: { server: 'm', facts: [] } };
  mergeWithPrevious(out, { at: 1000, memory: { server: 'm', facts: [{ content: 'KEEP' }] } }, 9999);
  assert.strictEqual(out.at, 1000, 'refreshing `at` would silence the staleness notice');
});

test('a genuinely fresh refresh keeps its own timestamp', () => {
  const out = { at: 9999, memory: { server: 'm', facts: [{ content: 'NEW' }] } };
  mergeWithPrevious(out, { at: 1000, memory: { server: 'm', facts: [{ content: 'OLD' }] } }, 9999);
  assert.strictEqual(out.at, 9999);
  assert.strictEqual(out.memory.facts[0].content, 'NEW');
  assert.ok(!out.memory.stale);
});

test('a server reachable as a flat tool is excluded from the code-mode roster', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {});
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(),
    skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' },
    memory: null,
    roster: { teamskills: ['skill_search'], tracker: ['a', 'b'] },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj }, home);
  assert.strictEqual(r.status, 0);
  // The section claims these do not appear in the tool list; a flat server does.
  assert.doesNotMatch(r.stdout, /teamskills \(/);
  assert.match(r.stdout, /2 tools across 1 servers/);
});

// --- Skill precedence on every prompt -------------------------------------------
// The gateway library holds the team's validated procedures, so it must be consulted
// before the model reaches for its own skills or improvises. Naming only skill_search
// left the navigator unmentioned, and saying "search before starting" did not say
// anything about precedence over the model's own skills.

function runPromptSubmit(promptText, home, discovery) {
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify(
    Object.assign({ at: Date.now(), skills: null, memory: null }, discovery)
  ));
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'prompt-submit.cjs')], {
    input: JSON.stringify({ prompt: promptText }),
    env: {
      ...process.env,
      HOME: home,
      BIFROST_URL: 'https://gateway.example.test/mcp',
      BIFROST_VK: 'test-key',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
}

const FLAT_SKILLS = { skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' } };

test('the prompt nudge names BOTH skill_search and skill_navigate', () => {
  const r = runPromptSubmit('debug the failing webhook', tmpHome(), FLAT_SKILLS);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /skill_search/, 'search must be offered');
  assert.match(r.stdout, /skill_navigate/, 'navigate must be offered as the fallback');
  assert.match(r.stdout, /get_skill/, 'loading a match must be spelled out');
});

test('search is presented before navigate', () => {
  const r = runPromptSubmit('implement the retry logic', tmpHome(), FLAT_SKILLS);
  assert.ok(
    r.stdout.indexOf('skill_search') < r.stdout.indexOf('skill_navigate'),
    'search is the primary route; the navigator tree is deep and auto-labelled'
  );
});

test('the nudge orders the search first without overclaiming the library', () => {
  const r = runPromptSubmit('review this merge request', tmpHome(), FLAT_SKILLS);
  assert.match(r.stdout, /before|first/i, 'must establish ordering, not merely suggest');
  // An earlier version called the contents "the team's validated procedures". Nobody
  // validated a thousand skills, and telling the model to defer to a bad match is
  // worse than not mentioning the library: the one thing worse than missing a skill
  // is following the wrong one.
  assert.ok(!/validated/i.test(r.stdout), 'must not claim the library is validated');
  assert.ok(!/take[s]? precedence/i.test(r.stdout), 'must not demand blind deference');
  assert.match(r.stdout, /judge|merits/i, 'must tell the model to evaluate the match');
});

test('the nudge spells calls for a code-mode gateway too', () => {
  const r = runPromptSubmit('deploy the service', tmpHome(), {
    skills: { server: 'teamskills', mode: 'code', tool: 'skill_search' },
  });
  assert.match(r.stdout, /executeToolCode/);
  assert.match(r.stdout, /result = teamskills\.skill_search\(/);
  assert.match(r.stdout, /result = teamskills\.skill_navigate\(/);
  assert.ok(!r.stdout.includes('mcp__bifrost__'), 'must not offer flat names on a code-mode gateway');
});

test('no discovery cache means no nudge at all', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'prompt-submit.cjs')], {
    input: JSON.stringify({ prompt: 'debug the thing' }),
    env: { ...process.env, HOME: home, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'a fabricated tool name is worse than silence');
});

// --- The write half of the loop (Stop hook) ---------------------------------------
// Stop fires after EVERY assistant response and exit code 2 BLOCKS the turn from
// ending. Both properties make this the most dangerous event in the plugin, so the
// tests here are mostly about it staying quiet and staying out of the way.

const reflect = require('../hooks/session-reflect.cjs');

// Always pins CLAUDE_PROJECT_DIR to a throwaway directory. A hook spawned without it
// falls back to process.cwd(), which under `npm test` is this repository — the suite
// was creating .bifrost/ in the plugin's own working tree.
function runReflect(event, home, projectDir) {
  const proj = projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'proj-reflect-'));
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-reflect.cjs')], {
    input: JSON.stringify(event),
    cwd: proj,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: proj,
      BIFROST_URL: 'https://gateway.example.test/mcp',
      BIFROST_VK: 'test-key',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function homeWithSkillsAndMemory() {
  const home = tmpHome();
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(),
    skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' },
    memory: { server: 'teammemory', mode: 'flat', tool: 'teammemory-memory_search' },
  }));
  return home;
}

test('the reflect hook always exits 0, whatever it is fed', () => {
  const home = homeWithSkillsAndMemory();
  for (const input of ['', 'not json', '{}', '{"session_id":null}']) {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-exit-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-reflect.cjs')], {
      input, cwd: proj,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
      encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(r.status, 0, `exit 2 on Stop would block the turn (input: ${input})`);
  }
});

// Each of these uses a unique session id and removes its marker afterwards:
// shouldPrompt persists turn counts to a real directory, so a fixed id would carry
// state between runs and make the firing pattern drift.
function withSession(fn) {
  // Isolate HOME: an earlier version drove the real state directory and deleted the
  // developer's own live session markers when the suite ran.
  const home = tmpHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  const id = `test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { return fn(id); }
  finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
}

test('it stays silent early, then checks in periodically', () => withSession((sid) => {
  // Stop fires after every response, so the value here is in what it does NOT do.
  const fired = [];
  for (let turn = 1; turn <= 30; turn += 1) {
    if (reflect.shouldPrompt(sid)) fired.push(turn);
  }
  const first = reflect.MIN_TURNS_BEFORE_PROMPT;
  const step = reflect.PROMPT_INTERVAL_TURNS;
  assert.strictEqual(fired[0], first, 'first check-in waits for a real session');
  for (let i = 1; i < fired.length; i += 1) {
    assert.strictEqual(fired[i] - fired[i - 1], step, 'later check-ins are evenly spaced');
  }
  assert.ok(fired.length >= 3, 'a long session is asked more than once');
  assert.ok(fired.length < 30 / 2, 'but nowhere near every turn');
}));

test('the check-in number increments so later prompts differ', () => withSession((sid) => {
  const seen = [];
  for (let turn = 1; turn <= 20; turn += 1) {
    const n = reflect.shouldPrompt(sid);
    if (n) seen.push(n);
  }
  assert.deepStrictEqual(seen, seen.map((_, i) => i + 1), 'check-ins are numbered 1,2,3…');
  assert.match(reflect.reflection({ memory: { server: 'm', mode: 'flat' } }, 1), /check-in\.\*\*/);
  assert.match(reflect.reflection({ memory: { server: 'm', mode: 'flat' } }, 3), /check-in \(3\)/);
}));

test('sessions are counted independently', () => {
  const home = homeWithSkillsAndMemory();
  for (let i = 0; i < reflect.MIN_TURNS_BEFORE_PROMPT; i += 1) runReflect({ session_id: 'a' }, home);
  let fired = false;
  for (let i = 0; i < reflect.MIN_TURNS_BEFORE_PROMPT; i += 1) {
    if (runReflect({ session_id: 'b' }, home).stdout.trim()) fired = true;
  }
  assert.ok(fired, 'a concurrent session gets its own check-in schedule');
});

test('stop_hook_active suppresses it entirely (no re-entry)', () => {
  const home = homeWithSkillsAndMemory();
  for (let i = 0; i < 6; i += 1) {
    const r = runReflect({ session_id: 'reentrant', stop_hook_active: true }, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  }
});

test('with no credential it does nothing', () => {
  const home = homeWithSkillsAndMemory();
  for (let i = 0; i < 6; i += 1) {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-nocreds-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-reflect.cjs')], {
      input: JSON.stringify({ session_id: 'nocreds' }),
      cwd: proj,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj, BIFROST_URL: '', BIFROST_VK: '' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(r.stdout.trim(), '');
  }
});

test('the emitted payload is valid JSON in the additionalContext shape', () => {
  const home = homeWithSkillsAndMemory();
  let out = '';
  for (let i = 0; i < reflect.MIN_TURNS_BEFORE_PROMPT; i += 1) {
    out = runReflect({ session_id: 'shape' }, home).stdout || out;
  }
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(parsed.hookSpecificOutput.additionalContext.length > 100);
});

test('candidates go to a LOCAL file, never straight into shared memory', () => {
  // memory_search's filters (wing, room, tier, agent_id, conversation_id,
  // include_expired) are the caller's retrieval narrowing, not a read ACL — the next
  // caller simply omits them — so anything stored in the corpus is recalled by every
  // colleague immediately. A `candidate` tag would label nothing for the reader and
  // gate nothing. A local file is the only place a candidate is verifiably not recalled.
  const caps = {
    memory: { server: 'teammemory', mode: 'flat', tool: 'teammemory-memory_search' },
    skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' },
  };
  const text = reflect.reflection(caps);
  assert.match(text, /candidates\.md/, 'must name the local spool file');
  assert.match(text, /\.bifrost/, 'the spool lives in the project, not ~/.cache');
  assert.match(text, /local/i, 'must say the file is local');
  assert.ok(!/tags` must include/.test(text),
    'must not claim a tag keeps an entry out of recall — it does not');
  assert.match(text, /deliberate step|separate/i, 'promotion must be a separate human step');
  // The skill-gap case is folded into the criteria list rather than repeating the
  // tool name, which the agent already has from SessionStart and the prompt nudge.
  assert.match(text, /skill library came back with nothing/i,
    'a task solved after a failed skill search belongs in the file too');
});

test('the check-in explains WHY it is not writing to shared memory', () => {
  // Without the reason the instruction reads as a limitation and invites the agent to
  // "helpfully" store to the corpus instead.
  const text = reflect.reflection({ memory: { server: 'teammemory', mode: 'flat' } });
  assert.match(text, /every colleague|recalled by/i, 'must say who would see it');
  assert.match(text, /no correction path|correction/i, 'must give the reason it matters');
});

test('the check-in permits answering "nothing" and stays out of the way', () => {
  const text = reflect.reflection({ memory: { server: 'm', mode: 'flat' } });
  assert.match(text, /including "no"|empty answer/i, 'must make "nothing" an acceptable answer');
  assert.match(text, /not narrate|do not narrate/i, 'must not turn into user-visible chatter');
});

test('the check-in spells a code-mode write correctly', () => {
  const text = reflect.reflection({ memory: { server: 'teammemory', mode: 'code' } });
  assert.match(text, /result = teammemory\.memory_store\(/);
  assert.ok(!text.includes('mcp__bifrost__'));
});

test('no memory server means no check-in at all', () => {
  assert.strictEqual(reflect.reflection({ skills: { server: 's', mode: 'flat' } }), null);
  assert.strictEqual(reflect.reflection(null), null);
});

test('session markers are pruned so the state dir cannot grow forever', () => withSession(() => {
  const dir = reflect.stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'test-ancient-marker.json');
  const fresh = path.join(dir, 'test-recent-marker.json');
  try {
    fs.writeFileSync(stale, '{}');
    const old = Date.now() - (reflect.MARKER_TTL_MS + 60000);
    fs.utimesSync(stale, new Date(old), new Date(old));
    fs.writeFileSync(fresh, '{}');

    reflect.pruneMarkers(Date.now());

    assert.ok(!fs.existsSync(stale), 'a marker past its TTL must be removed');
    assert.ok(fs.existsSync(fresh), 'a current marker must survive');
  } finally {
    for (const f of [stale, fresh]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}));

test('every exit in the Stop hook is exit 0', () => {
  // Not a style check: exit code 2 on Stop blocks the turn from ending, so a single
  // non-zero path here can hang a user's session. The invariant is absolute, which is
  // why it is asserted directly rather than only through the cases a test can trigger.
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'session-reflect.cjs'), 'utf8');
  const exits = src.match(/process\.exit\([^)]*\)/g) || [];
  assert.ok(exits.length > 0, 'expected explicit exits');
  for (const e of exits) {
    assert.strictEqual(e, 'process.exit(0)', `Stop must never exit non-zero, found: ${e}`);
  }
});

test('it exits 0 even when its own state directory is unusable', () => {
  // HOME pointing at a file makes every mkdir/write inside the hook throw.
  const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-bad-')), 'home-file');
  fs.writeFileSync(notADir, 'not a directory');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-reflect.cjs')], {
    input: JSON.stringify({ session_id: 'hostile' }),
    env: { ...process.env, HOME: notADir, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(r.status, 0, 'a broken cache dir must not block the turn');
});

test('a one-turn session is never interrupted by a check-in', () => {
  assert.ok(reflect.MIN_TURNS_BEFORE_PROMPT >= 2,
    'firing on the first Stop would prompt one-shot questions that learned nothing');
  const home = homeWithSkillsAndMemory();
  const r = runReflect({ session_id: 'one-shot' }, home);
  assert.strictEqual(r.stdout.trim(), '', 'the first turn must always be silent');
});

test('markers are pruned through the real hook run, not just the helper', () => withSession((sid) => {
  const dir = reflect.stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'test-flow-ancient.json');
  fs.writeFileSync(stale, '{}');
  const old = Date.now() - (reflect.MARKER_TTL_MS + 60000);
  fs.utimesSync(stale, new Date(old), new Date(old));
  try {
    // Drive the hook in-process against the real STATE_DIR until it fires.
    for (let i = 0; i < reflect.MIN_TURNS_BEFORE_PROMPT; i += 1) {
      reflect.shouldPrompt(sid);
    }
    assert.ok(!fs.existsSync(stale), 'firing must also prune expired markers');
  } finally {
    try { fs.unlinkSync(stale); } catch (_) {}
  }
}));

// --- Findings from the opus review ------------------------------------------------

test('later check-ins taper instead of repeating the criteria list', () => {
  // The plugin argues elsewhere that an unchanging repeated directive competes for
  // attention with new context. The check-in body was ~500 tokens and byte-identical
  // every 8 turns, which is that same mistake at 3x the size of the prompt nudge.
  const caps = { memory: { server: 'm', mode: 'flat' } };
  const first = reflect.reflection(caps, 1);
  const later = reflect.reflection(caps, 2);
  assert.ok(later.length * 3 < first.length, `later check-in must be far shorter (${later.length} vs ${first.length})`);
  assert.match(later, /check-in \(2\)/);
  assert.match(later, /nothing/i, 'must still permit an empty answer');
  assert.ok(!/Worth recording:/.test(later), 'the criteria list must not repeat');
});

test('the candidate spool lives in the project, not in a cache directory', () => {
  // ~/.cache is regenerable-data by XDG convention and gets purged by cleaners; the
  // only copy of unreviewed knowledge must not live there. In-project also avoids a
  // permission prompt on every append for anyone not running with permissions skipped.
  const f = reflect.candidateFile('/tmp/some-project');
  assert.strictEqual(f, path.join('/tmp/some-project', '.bifrost', 'candidates.md'));
  assert.ok(!/\.cache/.test(f), 'must not sit under ~/.cache');
});

test('the spool is created git-ignored so candidates never reach a commit', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-spool-'));
  const file = reflect.ensureCandidateFile(proj);
  assert.ok(file && fs.existsSync(file), 'the hook must create the file, not the agent');
  const ignore = path.join(proj, '.bifrost', '.gitignore');
  assert.ok(fs.existsSync(ignore), 'a .gitignore must be written alongside it');
  assert.strictEqual(fs.readFileSync(ignore, 'utf8').trim(), '*',
    'unreviewed mid-session judgements are not repository content');
});

test('creating the spool twice does not clobber recorded candidates', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-spool-'));
  const file = reflect.ensureCandidateFile(proj);
  fs.appendFileSync(file, '- IMPORTANT FINDING\n');
  reflect.ensureCandidateFile(proj);
  assert.match(fs.readFileSync(file, 'utf8'), /IMPORTANT FINDING/);
});

test('a stale discovery cache stops the tool roster being injected', () => {
  // The roster was read through a path that skipped the TTL, so a dead gateway kept
  // injecting an arbitrarily old roster while the notice said context was skipped.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now() - (365 * 24 * 60 * 60 * 1000),
    skills: null, memory: null, roster: { tracker: ['a', 'b'] },
  }));
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
  }, home);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /Bifrost MCP tools/, 'a year-old roster must not be emitted');
});

test('the staleness notice names what was actually skipped', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now() - (365 * 24 * 60 * 60 * 1000), skills: null, memory: null, roster: { t: ['a'] },
  }));
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
  }, home);
  assert.match(r.stdout, /tool roster/i,
    'the roster expired too, so the notice must say so rather than only naming skills/memory');
});

test('a large payload survives a piped run without truncation', () => {
  // stdout to a pipe is asynchronous on Windows and process.exit() does not flush it.
  // Seed a full cache so the emitted block is realistically sized (~9KB), then assert
  // that content written LAST still arrives.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = seedCache(home, proj, {
    skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' },
    memory: { server: 'teammemory', mode: 'flat', total: 14018, facts: [{ content: 'seeded fact' }] },
  });
  const roster = {};
  for (let i = 0; i < 13; i += 1) {
    roster[`server_${i}`] = Array.from({ length: 40 }, (_, j) => `tool_${i}_${j}`);
  }
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at: Date.now(),
    skills: { server: 'teamskills', mode: 'flat', tool: 'teamskills-skill_search' },
    memory: { server: 'teammemory', mode: 'flat', tool: 'teammemory-memory_search' },
    roster,
  }));
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
  }, home);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.length > 6000, `expected a large payload, got ${r.stdout.length} bytes`);
  // The memory section is emitted after the roster; its fence closes the block.
  assert.match(r.stdout, /<\/untrusted-reference-data>/, 'the tail of the payload must arrive');
});

test('the candidate spool explains collective server-side promotion', () => {
  // A write path whose output nothing reads is not a loop. The review command is what
  // makes a candidate promotable rather than merely recorded.
  const cmd = path.join(ROOT, 'commands', 'bifrost-candidates.md');
  assert.ok(fs.existsSync(cmd), 'a review command must ship with the spool');
  const body = fs.readFileSync(cmd, 'utf8');
  assert.match(body, /candidates\.md/, 'must name the file it reads');
  assert.match(body, /server—not this\s+local file—governs collective promotion/i);
  assert.match(body, /"status":"pending"/,
    'collective acceptance must not be presented as a direct write');
  assert.match(body, /candidate_id/,
    'a collective candidate must remain traceable while unresolved');
});

test('memory write guidance carries the v0.40 structured-claim contract', () => {
  const context = fs.readFileSync(path.join(ROOT, 'guidance', 'bifrost-context.md'), 'utf8');
  const candidates = fs.readFileSync(path.join(ROOT, 'commands', 'bifrost-candidates.md'), 'utf8');
  for (const field of ['subject', 'valid_from', 'text']) {
    assert.match(context, new RegExp(`\\b${field}\\b`));
    assert.match(candidates, new RegExp(`\\b${field}\\b`));
  }
  assert.match(context, /advertised `memory_store` schema/);
  assert.match(context, /application `tenant` was removed/);
  assert.match(candidates, /current time/);
  assert.match(candidates, /"status":"queued"/);
  assert.match(candidates, /"status":"pending"/);
});

test('the debug skill explains stale gateway catalogs', () => {
  const debug = fs.readFileSync(path.join(ROOT, 'skills', 'bifrost-debug', 'SKILL.md'), 'utf8');
  assert.match(debug, /GET \/api\/mcp\/clients/);
  assert.match(debug, /JSON-RPC `tools\/list` POST/);
  assert.match(debug, /gateway process started/);
  assert.match(debug, /restart the Bifrost gateway process/);
  assert.match(debug, /new\s+arguments explicitly/);
  assert.match(debug, /MEMORY_DEPLOYMENT_MODE=collective/);
  assert.match(debug, /x-bifrost-vk-id/);
  assert.match(debug, /allowed_extra_headers/);
});

test('state paths follow HOME so they can be isolated', () => {
  // Resolved at require time, these were impossible to isolate: the suite drove the
  // real directory and deleted a live session's markers on the developer's machine.
  const prev = process.env.HOME;
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'home-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'home-b-'));
  try {
    process.env.HOME = a;
    const first = reflect.stateDir();
    process.env.HOME = b;
    const second = reflect.stateDir();
    assert.notStrictEqual(first, second, 'stateDir must re-resolve HOME on every call');
    assert.ok(first.startsWith(a), `expected ${first} under ${a}`);
    assert.ok(second.startsWith(b), `expected ${second} under ${b}`);
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});

// --- Emit tolerance vs refresh interval -------------------------------------------
// These are different questions. DISCOVERY_TTL_MS (1h) decides when to re-fetch over
// the network; the emit tolerance decides how old cached content may be and still be
// worth showing. Conflating them made the roster vanish from any session starting
// more than an hour after the last refresh, while skills and memory stayed.

function sessionWithCacheAge(ageMinutes) {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-age-'));
  const at = Date.now() - (ageMinutes * 60 * 1000);
  const dir = path.join(home, '.cache', 'bifrost-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify({
    at,
    skills: { server: 's', mode: 'flat', tool: 's-skill_search' },
    memory: { server: 'm', mode: 'flat', tool: 'm-memory_search' },
    roster: { gitlab: ['a', 'b'] },
  }));
  const label = path.basename(proj).replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(proj).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(dir, `inject-${label}-${digest}.json`), JSON.stringify({
    at,
    skills: { server: 's', mode: 'flat' },
    memory: { server: 'm', mode: 'flat', total: 1, facts: [{ content: 'f' }] },
  }));
  return runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
  }, home).stdout;
}

test('the roster survives a cache older than the refresh interval', () => {
  // 90 minutes is past DISCOVERY_TTL_MS but well inside the emit tolerance. Any
  // session starting more than an hour after the last refresh hit this, which is
  // most of them under normal intermittent use.
  const out = sessionWithCacheAge(90);
  assert.match(out, /Bifrost MCP tools/, 'a 90-minute-old roster must still be emitted');
});

test('the roster expires with the rest of the cached context, not before it', () => {
  const out = sessionWithCacheAge(25 * 60);
  assert.doesNotMatch(out, /Bifrost MCP tools/, 'past the emit tolerance it must go');
  assert.doesNotMatch(out, /Bifrost memory —/, 'skills and memory expire at the same point');
});

test('readDiscoveryCacheSync requires an explicit tolerance', () => {
  // An unbounded read is what let a permanently dead gateway inject a roster of
  // arbitrary age, so calling without one must yield nothing rather than everything.
  assert.strictEqual(gw.readDiscoveryCacheSync(undefined), null);
  assert.strictEqual(gw.readDiscoveryCacheSync(NaN), null);
});

test('a spool that cannot be created suppresses the check-in', () => {
  // Otherwise the agent is told to append to a path that provably does not work.
  const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ro-')), 'file');
  fs.writeFileSync(notADir, 'x');
  assert.strictEqual(reflect.ensureCandidateFile(notADir), null,
    'creation under a non-directory must fail cleanly');

  const home = homeWithSkillsAndMemory();
  let out = '';
  for (let i = 0; i < reflect.MIN_TURNS_BEFORE_PROMPT; i += 1) {
    out = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-reflect.cjs')], {
      input: JSON.stringify({ session_id: 'ro-session' }),
      env: {
        ...process.env, HOME: home, CLAUDE_PROJECT_DIR: notADir,
        BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k',
      },
      encoding: 'utf8', timeout: 10000,
    }).stdout || out;
  }
  assert.strictEqual(out.trim(), '', 'no check-in when the spool cannot exist');
});

// --- The feedback signal ----------------------------------------------------------
// Every instruction this plugin injects was, until now, asserted rather than measured.
// The counter records which capability classes a session actually used so SessionStart
// can respond. It records counts only — never queries, arguments, results or content.

const usage = require('../hooks/usage.cjs');

function withUsageHome(fn) {
  const home = tmpHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return fn(home); }
  finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
}

test('only gateway tools are classified; everything else is ignored', () => {
  assert.strictEqual(usage.classify('mcp__bifrost__teamskills-skill_search'), 'skills');
  assert.strictEqual(usage.classify('mcp__bifrost__teammemory-memory_store'), 'memory');
  assert.strictEqual(usage.classify('mcp__plugin_bifrost-plugin_bifrost__executeToolCode'), 'code');
  assert.strictEqual(usage.classify('Bash'), null, 'ordinary tools must not be counted');
  assert.strictEqual(usage.classify('Read'), null);
  assert.strictEqual(usage.classify(''), null);
  // A local (non-MCP) tool may legitimately share a name with a gateway one. Matching
  // on the name alone would then attribute a user's own tooling to the gateway and
  // report usage that never happened — which is worse than no measurement.
  assert.strictEqual(usage.classify('get_skill'), null, 'a local tool of the same name is not the gateway');
  assert.strictEqual(usage.classify('memory_search'), null);
  assert.strictEqual(usage.classify('executeToolCode'), null);
});

test('memory_store is tracked separately — it is the only write in the system', () => {
  assert.ok(usage.isWrite('mcp__bifrost__teammemory-memory_store'));
  assert.ok(!usage.isWrite('mcp__bifrost__teammemory-memory_search'));
});

test('the counter records counts and nothing else', () => withUsageHome(() => {
  usage.record('s1', 'mcp__bifrost__teamskills-skill_search', true);
  usage.record('s1', 'mcp__bifrost__teammemory-memory_store', true);
  const raw = fs.readFileSync(usage.usageFile(), 'utf8');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.sessions.length, 1);
  assert.strictEqual(parsed.sessions[0].skills, 1);
  assert.strictEqual(parsed.sessions[0].writes, 1);

  // The property that must hold: counts only, no content, ever. Asserted as an exact
  // key allowlist rather than a substring scan — a scan misses any field whose name
  // does not happen to be on the forbidden list, which is most of them.
  assert.deepStrictEqual(
    Object.keys(parsed.sessions[0]).sort(),
    ['at', 'code', 'errors', 'id', 'memory', 'skills', 'writes'],
    'no field may be added to the counter without a deliberate decision'
  );
  for (const v of Object.values(parsed.sessions[0])) {
    assert.ok(typeof v === 'number' || typeof v === 'string');
  }
}));

test('the summary counts sessions that used a capability, not raw calls', () => withUsageHome(() => {
  for (let i = 0; i < 9; i += 1) usage.record('busy', 'mcp__bifrost__teamskills-skill_search', true);
  usage.record('quiet', 'mcp__bifrost__teammemory-memory_search', true);
  const sum = usage.summary(null);
  assert.strictEqual(sum.sessions, 2);
  assert.strictEqual(sum.skills, 1, 'nine calls in one session is still one session');
  assert.strictEqual(sum.memory, 1);
}));

test('a session is not judged by its own activity', () => withUsageHome(() => {
  usage.record('me', 'mcp__bifrost__teamskills-skill_search', true);
  assert.strictEqual(usage.summary('me').sessions, 0, 'the asking session must be excluded');
}));

test('the rolling window is bounded', () => withUsageHome(() => {
  for (let i = 0; i < usage.MAX_SESSIONS + 15; i += 1) {
    usage.record(`s${i}`, 'mcp__bifrost__teamskills-skill_search', true);
  }
  const parsed = JSON.parse(fs.readFileSync(usage.usageFile(), 'utf8'));
  assert.ok(parsed.sessions.length <= usage.MAX_SESSIONS,
    `window must stay bounded, got ${parsed.sessions.length}`);
}));

test('the usage hook exits 0 on anything it is fed', () => {
  for (const input of ['', 'not json', '{}', '{"tool_name":"Bash"}']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'usage.cjs')], {
      input, env: { ...process.env, HOME: tmpHome() }, encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(r.status, 0, `input: ${input}`);
    assert.strictEqual(r.stdout.trim(), '', 'a counter must emit nothing into context');
  }
});

// --- The loop closing: observed behaviour changes what is injected ------------------

function sessionStartWithUsage(seed) {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-use-'));
  seedCache(home, proj, {
    skills: { server: 'teamskills', mode: 'flat' },
    memory: { server: 'teammemory', mode: 'flat', total: 10, facts: [] },
  });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { seed(); } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
  return runSessionStart({ CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://g.example/mcp', BIFROST_VK: 'k' }, home);
}

test('an agent that never searches gets told so, with the number', () => {
  const r = sessionStartWithUsage(() => {
    for (let i = 0; i < 5; i += 1) usage.record(`n${i}`, 'mcp__bifrost__teammemory-memory_search', true);
  });
  assert.match(r.stdout, /have not searched this library once in the last 5 sessions/,
    'a standing paragraph that has demonstrably not worked should escalate');
});

test('an agent that already searches gets a short section, not the argument again', () => {
  const long = sessionStartWithUsage(() => {});
  const habitual = sessionStartWithUsage(() => {
    for (let i = 0; i < 5; i += 1) usage.record(`h${i}`, 'mcp__bifrost__teamskills-skill_search', true);
  });
  assert.ok(habitual.stdout.length < long.stdout.length,
    'compliance should cost fewer tokens, not the same');
  assert.doesNotMatch(habitual.stdout, /Skipping the search is what costs/,
    'the persuasion drops away once it has worked');
  assert.match(habitual.stdout, /skill_search/, 'the call itself must remain');
});

test('too little data means no adaptation at all', () => {
  const r = sessionStartWithUsage(() => {
    usage.record('only-one', 'mcp__bifrost__teammemory-memory_search', true);
  });
  assert.doesNotMatch(r.stdout, /have not searched this library once/,
    'one observation is not a habit; the neutral text must stand');
});

test('the suite never writes into the plugin repository itself', () => {
  // Twice now a hook has written to real user state during tests: once to the real
  // ~/.cache (deleting a developer's live session markers), once to <repo>/.bifrost
  // because a spawned hook without CLAUDE_PROJECT_DIR falls back to process.cwd().
  // Both were found by hand. This makes the third instance fail the run instead.
  //
  // A real session working in this repo legitimately leaves `.bifrost/candidates.md`
  // behind, so "does it exist" is the wrong question — compare against the snapshot
  // taken at module load, before any test ran, and fail on anything THIS RUN created
  // or modified.
  for (const { stray, full, before } of REPO_STATE_GUARD) {
    const after = snapshotRepoStatePath(full);
    if (!before.exists) {
      assert.ok(!after.exists,
        `${stray} was created in the repo during this run — a hook ran with cwd or HOME pointing here`);
      continue;
    }
    assert.ok(after.exists && after.isDir === before.isDir,
      `${stray} was removed or replaced during this run`);
    if (!before.isDir) {
      assert.strictEqual(after.mtimeMs, before.mtimeMs, `${stray} was modified during this run`);
      continue;
    }
    const beforeKeys = [...before.entries.keys()].sort();
    const afterKeys = [...after.entries.keys()].sort();
    assert.deepStrictEqual(afterKeys, beforeKeys,
      `${stray} gained or lost files during this run — a hook wrote into it`);
    for (const key of beforeKeys) {
      assert.strictEqual(after.entries.get(key), before.entries.get(key),
        `${stray}/${key} was modified during this run`);
    }
  }
});

test('two servers offering the same capability resolve deterministically', () => {
  // tools/list order is not promised to be stable, so first-match meant the capability
  // could silently switch servers between refreshes with nothing reporting it.
  const names = ['zzz-skill_search', 'aaa-skill_search', 'mmm-skill_search'];
  const results = [];
  for (const order of [names, names.slice().reverse(), [names[1], names[2], names[0]]]) {
    const sorted = order.slice().sort();
    const hit = sorted.find((n) => /skill_search$/.test(n));
    results.push(hit);
  }
  assert.strictEqual(new Set(results).size, 1, `resolution varied by input order: ${results}`);
  assert.strictEqual(results[0], 'aaa-skill_search', 'must be a stable, order-independent choice');
});

test('discovery picks the same server whatever order the gateway lists tools in', async () => {
  const forward = await discoverAgainst(['aaa-skill_search', 'zzz-skill_search']);
  const reverse = await discoverAgainst(['zzz-skill_search', 'aaa-skill_search']);
  assert.strictEqual(forward.disc.skills.server, reverse.disc.skills.server,
    'the same gateway must resolve to the same skills server on every refresh');
});

test('all three manifests carry the same version', () => {
  // Three files declare a version and nothing checked they agreed: npm reads
  // package.json, the plugin loader reads .claude-plugin/plugin.json, and the
  // marketplace reads .claude-plugin/marketplace.json. A release that bumps two of
  // three is invisible until someone installs it. This was missed on the 1.4.0 bump
  // and found by grep, which is not a process.
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version;
  const pkg = read('package.json');
  assert.match(pkg, /^\d+\.\d+\.\d+$/, `package.json version looks wrong: ${pkg}`);
  assert.strictEqual(read('.claude-plugin/plugin.json'), pkg, 'plugin.json is out of step');
  assert.strictEqual(read('.claude-plugin/marketplace.json'), pkg, 'marketplace.json is out of step');
});

test('the released version has a changelog entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.includes(`## [${pkg}]`), `CHANGELOG has no section for ${pkg}`);
});

test('no private key material ships in the package', () => {
  // An orphaned Ed25519 private key fixture was being published inside the plugin
  // tarball as hooks/lib/__fixtures__/test-signing-key.pem. Nothing referenced it —
  // the signature tests generate keypairs at runtime — but a file named
  // *signing-key.pem containing "BEGIN PRIVATE KEY" in a public package trips every
  // secret scanner and invites exactly the wrong conclusion during an audit.
  const shipped = require(path.join(ROOT, 'package.json')).files;
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)); }
      else out.push(p);
    }
    return out;
  };
  for (const top of shipped) {
    const abs = path.join(ROOT, top.replace(/\/$/, ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    for (const f of walk(abs)) {
      assert.ok(!/\.(pem|key|p12|pfx)$/i.test(f), `key material must not ship: ${path.relative(ROOT, f)}`);
      if (/\.(md|json|cjs|js)$/.test(f)) continue;
      const body = fs.readFileSync(f, 'utf8');
      assert.ok(!/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(body),
        `private key material in a shipped file: ${path.relative(ROOT, f)}`);
    }
  }
});

test('a server-name collision is detected and reported, not left silent', () => {
  // Both documented install methods register a server named `bifrost`. With both
  // present the project entry cannot expand and mcp__bifrost__* disappears, while
  // `claude mcp list` still shows a connected bifrost — so it reads as a gateway
  // outage. This cost real debugging time; the plugin should just say it.
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-collide-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: '${BIFROST_URL}', headers: { 'x-bf-vk': '${BIFROST_VK}' } } },
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: 'https://real.example/mcp', headers: { 'x-bf-vk': 'VK' } } },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj, BIFROST_URL: '', BIFROST_VK: '' }, home);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /server-name collision/i);
  assert.match(r.stdout, /claude mcp remove bifrost -s user/);
});

test('no collision is reported when the project entry resolves', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-ok-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: '${BIFROST_URL}', headers: { 'x-bf-vk': '${BIFROST_VK}' } } },
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: 'https://real.example/mcp', headers: { 'x-bf-vk': 'VK' } } },
  }));
  // Environment supplies the placeholder, so both sides resolve — nothing to report.
  const r = runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: 'https://real.example/mcp', BIFROST_VK: 'VK',
  }, home);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

test('a project with no .mcp.json never reports a collision', () => {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-none-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: 'https://real.example/mcp', headers: { 'x-bf-vk': 'VK' } } },
  }));
  const r = runSessionStart({ CLAUDE_PROJECT_DIR: proj, BIFROST_URL: '', BIFROST_VK: '' }, home);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

// The detector's own comment promised "if both sides resolve to the same endpoint there
// is nothing to report", but it only ever asked whether the project entry expanded to
// something non-empty and never compared the two urls. So BIFROST_URL=https://A against
// a user-scope `bifrost` at https://B returned null: no report, while the user-scope
// entry wins and the session silently answers from B. Nothing else in a session hints
// at that — the tools are all present and working, against the wrong corpus.

function collisionFixture(projectUrl, userUrl) {
  const home = tmpHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-collide-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: { bifrost: { type: 'http', url: '${BIFROST_URL}', headers: { 'x-bf-vk': '${BIFROST_VK}' } } },
  }));
  if (userUrl) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { bifrost: { type: 'http', url: userUrl, headers: { 'x-bf-vk': 'VK' } } },
    }));
  } else {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  }
  return runSessionStart({
    CLAUDE_PROJECT_DIR: proj, BIFROST_URL: projectUrl, BIFROST_VK: 'VK',
  }, home);
}

test('two entries resolving to DIFFERENT endpoints are reported', () => {
  const r = collisionFixture('https://project-gateway.example/mcp', 'https://user-gateway.example/mcp');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /server-name collision/i);
  // Naming only one side would leave the reader unable to tell which one they are
  // actually reaching, which is the entire question this notice has to answer.
  assert.match(r.stdout, /project-gateway\.example/, 'the declared endpoint must be named');
  assert.match(r.stdout, /user-gateway\.example/, 'the endpoint actually in use must be named');
  assert.match(r.stdout, /claude mcp remove bifrost -s user/);
});

test('two entries resolving to the SAME endpoint are not reported', () => {
  const r = collisionFixture('https://same.example/mcp', 'https://same.example/mcp');
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

test('a trailing slash or a cased host is not a different endpoint', () => {
  // Both spellings reach one server, so reporting them would train people to ignore
  // the notice — which costs more than the case it would catch.
  const r = collisionFixture('https://Same.Example/mcp/', 'https://same.example/mcp');
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

test('a different PATH on the same host is still a collision', () => {
  // Only the parts an HTTP client ignores are folded away; a route is not one of them.
  const r = collisionFixture('https://same.example/mcp', 'https://same.example/other-mcp');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /server-name collision/i);
});

test('an unresolvable placeholder is still reported', () => {
  // The pre-existing behaviour: no user-supplied value, so the project entry cannot
  // expand at all and the tools disappear outright.
  const r = collisionFixture('', 'https://user-gateway.example/mcp');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /server-name collision/i);
  assert.match(r.stdout, /unset placeholder/i, 'the unresolved case must keep its own wording');
});

test('a user-scope entry holding the same placeholder is not a collision', () => {
  // Collapsing the gateway key to a single source leaves the user-scope entry holding
  // `${BIFROST_URL}` rather than a literal. Both entries then name the SAME endpoint.
  // Expanding only the project side compared a resolved url against the raw string
  // "${BIFROST_URL}", called them divergent, and fired the notice every single session.
  const r = collisionFixture('https://same.example/mcp', '${BIFROST_URL}');
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

test('a user-scope placeholder that cannot expand is reported, not silently compared', () => {
  // The user entry wins the name, so if IT has no endpoint the tools are gone — the same
  // failure as an unresolvable project entry, and it must not read as "same endpoint".
  const r = collisionFixture('https://same.example/mcp', '${BIFROST_UNSET_XYZ}');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /server-name collision/i);
});

test('no user-scope entry at all means no collision', () => {
  // Nothing to collide with — the project entry owns the name outright.
  const r = collisionFixture('https://project-gateway.example/mcp', null);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /server-name collision/i);
});

test('sameEndpoint never calls an unparseable string equal to a real url', () => {
  assert.ok(gw.sameEndpoint('https://h/mcp', 'https://h/mcp/'));
  assert.ok(gw.sameEndpoint('https://H/mcp', 'https://h/mcp'));
  assert.ok(gw.sameEndpoint('https://h:443/mcp', 'https://h/mcp'));
  assert.ok(gw.sameEndpoint('https://h/mcp#frag', 'https://h/mcp'));
  assert.ok(!gw.sameEndpoint('https://h/mcp?k=1', 'https://h/mcp'));
  assert.ok(!gw.sameEndpoint('http://h/mcp', 'https://h/mcp'));
  assert.ok(!gw.sameEndpoint('not a url', 'https://h/mcp'));
  assert.ok(!gw.sameEndpoint('', 'https://h/mcp'));
});
