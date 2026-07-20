'use strict';
// Tests for the signed plugin-config client (hooks/lib/plugin-config.cjs).
//
// Style mirrors keyapp/test/*.test.js: node:test + node:assert/strict, a local mock
// server, no external deps.
//
// HOME is redirected to a temp dir BEFORE requiring the module under test, because it
// resolves its cache dir from os.homedir() at require time.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-plugincfg-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const pc = require('../hooks/lib/plugin-config.cjs');

// ---- golden vector: captured from the LIVE gateway (mac107, keyapp, 2026-07-13) -----
// This is the whole point of the exercise: if our canonicalization drifts one byte from
// keyapp/lib/plugincfg.js:102-104, this test fails and every real signature stops
// verifying. It pins the mirror against production, not against our own mock.
const LIVE = {
  publicKeyPem:
    '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAj2u3tynTVQmjrtVoW+UE5dat6UkxXLpwgU7dLqpn3KI=\n' +
    '-----END PUBLIC KEY-----\n',
  manifest: {
    schemaVersion: 1,
    minBootstrapVersion: '1.2.0',
    configVersion: '2026-07-13.1',
    sha256: '1edd9d9dc7efa05a9b78175ae37d99d268d12dadfa6cbe5b7e530f626b70903c',
    bundleUrl: '/plugin-config/bundle/1edd9d9dc7efa05a9b78175ae37d99d268d12dadfa6cbe5b7e530f626b70903c.json',
    signature: 'x+00y//qznGpsaAVF3Wnd/oikp0MKPUSlh4HPmvNLeqITI3mfzcQYYy1niU5RPvwW7qUsDDDQgXvLZN76yGwBA==',
    signingKeyId: 'keyapp-v2',
  },
};

test('canonicalization matches keyapp byte-for-byte (live signature verifies)', () => {
  assert.equal(
    pc.canonicalManifestPayload(LIVE.manifest),
    '{"schemaVersion":1,"minBootstrapVersion":"1.2.0","configVersion":"2026-07-13.1",' +
      '"sha256":"1edd9d9dc7efa05a9b78175ae37d99d268d12dadfa6cbe5b7e530f626b70903c",' +
      '"signingKeyId":"keyapp-v2"}'
  );
  assert.equal(pc.verifyManifest(LIVE.manifest, LIVE.publicKeyPem), true);
});

test('a manifest field tampered after signing does not verify (signature covers all of them)', () => {
  for (const field of ['schemaVersion', 'minBootstrapVersion', 'configVersion', 'sha256', 'signingKeyId']) {
    const tampered = { ...LIVE.manifest, [field]: field === 'schemaVersion' ? 2 : 'evil' };
    assert.equal(pc.verifyManifest(tampered, LIVE.publicKeyPem), false, `${field} tamper was accepted`);
  }
});

// ---- mock keyapp ---------------------------------------------------------

const BUNDLE = {
  hooks: {
    'session-start': {
      enabled: true,
      fields: { memoryInject: false, skillsInject: true },
      lockedFields: ['memoryInject'],
    },
  },
  tools: [
    { client: 'sentry', tool: 'create_project', state: 'off' },
    { client: 'exa', tool: 'web_search_exa', state: 'available' },
  ],
  skills: [
    { id: 'safe-skill', state: 'available' },
    { id: 'banned-skill', state: 'off' },
    { id: 'mandatory-skill', state: 'always_on' },
    { id: 'opted-out-skill', state: 'available', optedIn: false },
  ],
};

// A mock keyapp that signs exactly the way keyapp/lib/plugincfg.js does.
// `mutate` lets a test corrupt the manifest AFTER signing, i.e. exactly what an attacker
// on the wire could do.
function startMockKeyapp({ configVersion = 'v1', minBootstrapVersion = '1.0.0', schemaVersion = 1,
                           signingKeyId = 'keyapp-v2', keys, mutate, bundleBody } = {}) {
  const kp = keys || crypto.generateKeyPairSync('ed25519');
  const bundleJson = bundleBody !== undefined ? bundleBody : JSON.stringify(BUNDLE);
  const sha = crypto.createHash('sha256').update(JSON.stringify(BUNDLE)).digest('hex');

  const counts = { manifest: 0, bundle: 0, key: 0 };

  const srv = http.createServer((req, res) => {
    if (req.url === '/plugin-config/public-key') {
      counts.key++;
      res.writeHead(200, { 'content-type': 'application/x-pem-file' });
      return res.end(kp.publicKey.export({ type: 'spki', format: 'pem' }));
    }
    if (req.url === '/plugin-config/manifest.json') {
      counts.manifest++;
      if (!req.headers['x-bf-vk']) { res.writeHead(401); return res.end('no identity'); }
      const fields = { schemaVersion, minBootstrapVersion, configVersion, sha256: sha, signingKeyId };
      const signature = crypto
        .sign(null, Buffer.from(pc.canonicalManifestPayload(fields), 'utf8'), kp.privateKey)
        .toString('base64');
      let manifest = { ...fields, bundleUrl: `/plugin-config/bundle/${sha}.json`, signature };
      if (mutate) manifest = mutate(manifest);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(manifest));
    }
    if (req.url.startsWith('/plugin-config/bundle/')) {
      counts.bundle++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(bundleJson);
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ srv, counts, keys: kp, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) })
    );
  });
}

// Each test gets a clean slate: fresh cache dir, TTL off (so we always exercise the
// network path unless a test is specifically about the TTL short-circuit).
function reset(port) {
  fs.rmSync(path.join(HOME, '.cache', 'bifrost-plugin'), { recursive: true, force: true });
  process.env.BIFROST_KEYAPP_URL = `http://127.0.0.1:${port}`;
  process.env.BIFROST_VK = 'vk-test-not-a-real-key';
  process.env.BIFROST_PLUGIN_CONFIG_TTL_MS = '0';
  delete process.env.BIFROST_PLUGIN_CONFIG;
}

// ---- happy path ----------------------------------------------------------

test('valid signature -> bundle fetched, verified, cached, applied', async () => {
  const mock = await startMockKeyapp({ configVersion: 'v1' });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.config, BUNDLE);

    // and it is now readable with zero network
    assert.deepEqual(pc.loadCached(), BUNDLE);

    const cached = pc.readCache(process.env.BIFROST_KEYAPP_URL);
    assert.equal(cached.configVersion, 'v1');
    assert.equal(cached.signingKeyId, 'keyapp-v2');
    assert.match(cached.publicKeyPem, /BEGIN PUBLIC KEY/); // key pinned on first fetch (TOFU)
  } finally { await mock.close(); }
});

// ---- fail closed ---------------------------------------------------------

test('TAMPERED signature -> rejected, NOTHING applied, nothing cached', async () => {
  const mock = await startMockKeyapp({
    mutate: (m) => ({ ...m, signature: Buffer.from('nope'.repeat(16)).toString('base64') }),
  });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'bad-signature');
    assert.equal(r.config, null);          // nothing applied
    assert.equal(pc.loadCached(), null);   // nothing cached
    assert.equal(mock.counts.bundle, 0);   // never even fetched the bundle
  } finally { await mock.close(); }
});

test('TAMPERED manifest body (configVersion swapped post-signing) -> rejected', async () => {
  const mock = await startMockKeyapp({
    mutate: (m) => ({ ...m, configVersion: 'attacker-rollback' }),
  });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'bad-signature');
    assert.equal(pc.loadCached(), null);
  } finally { await mock.close(); }
});

test('sha256 mismatch (signed manifest, swapped bundle body) -> rejected, nothing applied', async () => {
  const mock = await startMockKeyapp({
    bundleBody: JSON.stringify({ skills: [{ id: 'evil', state: 'always_on' }] }),
  });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'bundle-unavailable');
    assert.equal(r.config, null);
    assert.equal(pc.loadCached(), null);
  } finally { await mock.close(); }
});

test('unannounced key rotation (same signingKeyId, different key) -> refused, keeps last verified config', async () => {
  const first = await startMockKeyapp({ configVersion: 'v1' });
  reset(first.port);
  try {
    assert.equal((await pc.refresh({})).status, 'updated'); // pins the key
  } finally { await first.close(); }

  // Same port, same signingKeyId, brand-new signing key — i.e. a silent key swap.
  const rotated = await startMockKeyapp({ configVersion: 'v2', signingKeyId: 'keyapp-v2' });
  process.env.BIFROST_KEYAPP_URL = `http://127.0.0.1:${rotated.port}`;
  try {
    // Re-pin the cache onto the new port's URL so the pinned key is the OLD one.
    const old = pc.readCache(`http://127.0.0.1:${first.port}`);
    pc.writeCache(process.env.BIFROST_KEYAPP_URL, old);

    const r = await pc.refresh({});
    assert.equal(r.status, 'key-rotation-unannounced');
    assert.deepEqual(r.config, BUNDLE);          // still running the LAST VERIFIED config
    assert.match(r.message, /DIFFERENT signing key/);
  } finally { await rotated.close(); }
});

test('minBootstrapVersion newer than the plugin -> refuses cleanly, applies nothing', async () => {
  const mock = await startMockKeyapp({ minBootstrapVersion: '99.0.0' });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'bootstrap-too-old');
    assert.equal(r.config, null);
    assert.match(r.message, /requires bifrost-plugin >= 99\.0\.0/);
    assert.equal(mock.counts.bundle, 0); // did not half-apply
    assert.equal(pc.loadCached(), null);
  } finally { await mock.close(); }
});

test('unsupported schemaVersion -> refuses cleanly', async () => {
  const mock = await startMockKeyapp({ schemaVersion: 2 });
  reset(mock.port);
  try {
    const r = await pc.refresh({});
    assert.equal(r.status, 'unsupported-schema');
    assert.equal(r.config, null);
    assert.equal(mock.counts.bundle, 0);
  } finally { await mock.close(); }
});

// ---- caching -------------------------------------------------------------

test('unchanged configVersion -> no bundle fetch and no key fetch', async () => {
  const mock = await startMockKeyapp({ configVersion: 'v1' });
  reset(mock.port);
  try {
    await pc.refresh({});
    assert.equal(mock.counts.bundle, 1);
    assert.equal(mock.counts.key, 1);

    await pc.refresh({}); // TTL is 0, so this really does re-check the manifest
    assert.equal(mock.counts.manifest, 2);
    assert.equal(mock.counts.bundle, 1, 'bundle re-fetched despite unchanged configVersion');
    assert.equal(mock.counts.key, 1, 'public key re-fetched despite an unchanged pinned keyId');
  } finally { await mock.close(); }
});

test('within TTL -> ZERO network calls', async () => {
  const mock = await startMockKeyapp({ configVersion: 'v1' });
  reset(mock.port);
  try {
    await pc.refresh({});
    const before = { ...mock.counts };
    process.env.BIFROST_PLUGIN_CONFIG_TTL_MS = String(60 * 60 * 1000);

    const r = await pc.refresh({});
    assert.equal(r.status, 'cached-fresh');
    assert.deepEqual(mock.counts, before, 'made a network call while the cache was fresh');
  } finally { await mock.close(); }
});

test('gateway down -> falls back to the cached verified config, never throws', async () => {
  const mock = await startMockKeyapp({ configVersion: 'v1' });
  reset(mock.port);
  await pc.refresh({});
  await mock.close(); // gateway is now dead

  const r = await pc.refresh({ timeoutMs: 500 });
  assert.equal(r.status, 'unreachable');
  assert.deepEqual(r.config, BUNDLE);       // degraded to cache
  assert.deepEqual(pc.loadCached(), BUNDLE);
});

test('cold cache + gateway down -> no config, still no throw', async () => {
  reset(1); // nothing listening on port 1
  const r = await pc.refresh({ timeoutMs: 500 });
  assert.equal(r.status, 'unreachable');
  assert.equal(r.config, null);
});

// ---- kill switch ---------------------------------------------------------

test('BIFROST_PLUGIN_CONFIG=0 disables the whole path', async () => {
  const mock = await startMockKeyapp({});
  reset(mock.port);
  try {
    await pc.refresh({});                      // warm the cache first
    assert.deepEqual(pc.loadCached(), BUNDLE);

    process.env.BIFROST_PLUGIN_CONFIG = '0';
    const before = { ...mock.counts };
    const r = await pc.refresh({});
    assert.equal(r.status, 'disabled');
    assert.equal(r.config, null);
    assert.equal(pc.loadCached(), null, 'cached config still applied with the kill switch on');
    assert.deepEqual(mock.counts, before, 'made a network call with the kill switch on');
  } finally { await mock.close(); }
});

// ---- applying the config -------------------------------------------------

test('hook fields: locked field beats env, unlocked field yields to env', () => {
  delete process.env.BIFROST_MEMORY_INJECT;
  delete process.env.BIFROST_SKILLS_INJECT;

  // server says memoryInject:false and LOCKS it -> user cannot turn it back on
  process.env.BIFROST_MEMORY_INJECT = '1';
  assert.equal(pc.hookFlag(BUNDLE, 'session-start', 'memoryInject', 'BIFROST_MEMORY_INJECT', true), false);

  // skillsInject is NOT locked -> the local env var wins
  process.env.BIFROST_SKILLS_INJECT = '0';
  assert.equal(pc.hookFlag(BUNDLE, 'session-start', 'skillsInject', 'BIFROST_SKILLS_INJECT', true), false);

  // ...and with no env var set, the server value applies
  delete process.env.BIFROST_SKILLS_INJECT;
  assert.equal(pc.hookFlag(BUNDLE, 'session-start', 'skillsInject', 'BIFROST_SKILLS_INJECT', true), true);

  // no config at all -> env/default, exactly as before this feature existed
  assert.equal(pc.hookFlag(null, 'session-start', 'memoryInject', 'BIFROST_MEMORY_INJECT', true), true);

  delete process.env.BIFROST_MEMORY_INJECT;
});

test('a disabled hook has no opinion — env/default wins', () => {
  const cfg = { hooks: { 'session-start': { enabled: false, fields: { memoryInject: false }, lockedFields: ['memoryInject'] } } };
  assert.equal(pc.hookFlag(cfg, 'session-start', 'memoryInject', 'BIFROST_MEMORY_INJECT', true), true);
});

test('tri-state skills/tools partition correctly', () => {
  const { off, alwaysOn } = pc.partitionSkills(BUNDLE);
  assert.deepEqual(off.sort(), ['banned-skill', 'opted-out-skill']); // 'off' + explicit user opt-out
  assert.deepEqual(alwaysOn, ['mandatory-skill']);
  assert.deepEqual(pc.offTools(BUNDLE), ['sentry.create_project']);
});

test('version compare', () => {
  assert.equal(pc.compareVersions('1.1.0', '1.2.0'), -1);
  assert.equal(pc.compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(pc.compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(pc.compareVersions('1.2.0-beta.1', '1.2.0'), 0); // prerelease ignored
});

test('this plugin satisfies the live gateway minBootstrapVersion', () => {
  assert.ok(
    pc.compareVersions(pc.pluginVersion(), LIVE.manifest.minBootstrapVersion) >= 0,
    `plugin ${pc.pluginVersion()} < required ${LIVE.manifest.minBootstrapVersion} — the gateway would refuse to configure it`
  );
});
