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
                           signingKeyId = 'keyapp-v2', keys, mutate, bundleBody, servedKeys } = {}) {
  const kp = keys || crypto.generateKeyPairSync('ed25519');
  const bundleJson = bundleBody !== undefined ? bundleBody : JSON.stringify(BUNDLE);
  const sha = crypto.createHash('sha256').update(JSON.stringify(BUNDLE)).digest('hex');

  const counts = { manifest: 0, bundle: 0, key: 0 };

  const srv = http.createServer((req, res) => {
    if (req.url === '/plugin-config/public-key') {
      counts.key++;
      res.writeHead(200, { 'content-type': 'application/x-pem-file' });
      return res.end((servedKeys ? servedKeys() : kp).publicKey.export({ type: 'spki', format: 'pem' }));
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

for (const [name, mutation, status] of [
  ['signature', (m) => ({ ...m, signature: Buffer.alloc(64).toString('base64') }), 'bad-signature'],
  ['schema', (m) => ({ ...m, schemaVersion: 999 }), 'unsupported-schema'],
  ['minimum version', (m) => ({ ...m, minBootstrapVersion: '99.0.0' }), 'bootstrap-too-old'],
  ['signed minimum version', (m) => ({ ...m, minBootstrapVersion: '0.0.0' }), 'bad-signature'],
  ['key id', (m) => ({ ...m, signingKeyId: 'tampered-key' }), 'bad-signature'],
]) {
  test(`unchanged content rejects tampered ${name} without renewing the verified cache`, async () => {
    let corrupt = false;
    const mock = await startMockKeyapp({ mutate: (m) => corrupt ? mutation(m) : m });
    reset(mock.port);
    try {
      assert.equal((await pc.refresh({})).status, 'updated');
      const url = process.env.BIFROST_KEYAPP_URL;
      const cached = { ...pc.readCache(url), at: 1 };
      pc.writeCache(url, cached);
      corrupt = true;

      const r = await pc.refreshAndRecord({ force: true });
      assert.equal(r.status, status);
      assert.deepEqual(r.config, BUNDLE);
      assert.deepEqual(pc.readCache(url), cached, 'rejected manifest changed the verified cache');
      assert.equal(mock.counts.bundle, 1, 'rejected manifest triggered a bundle request');
      assert.equal(pc.readNotice(url).status, status, 'refusal was not recorded');
    } finally { await mock.close(); }
  });
}

test('unchanged content rejects unannounced key rotation and retains its pin', async () => {
  const first = await startMockKeyapp();
  reset(first.port);
  await pc.refresh({});
  const cached = pc.readCache(process.env.BIFROST_KEYAPP_URL);
  await first.close();

  const rotated = await startMockKeyapp();
  process.env.BIFROST_KEYAPP_URL = `http://127.0.0.1:${rotated.port}`;
  pc.writeCache(process.env.BIFROST_KEYAPP_URL, cached);
  // This fixture deliberately moves the trusted pin to a fresh loopback port.
  const rebound = pc.readCache(process.env.BIFROST_KEYAPP_URL);
  try {
    const r = await pc.refresh({ force: true });
    assert.equal(r.status, 'key-rotation-unannounced');
    assert.deepEqual(r.config, BUNDLE);
    assert.deepEqual(pc.readCache(process.env.BIFROST_KEYAPP_URL), rebound);
    assert.equal(rotated.counts.bundle, 0);
  } finally { await rotated.close(); }
});

test('unchanged content accepts announced key rotation and pins the verified replacement', async () => {
  const first = await startMockKeyapp();
  reset(first.port);
  await pc.refresh({});
  const cached = pc.readCache(process.env.BIFROST_KEYAPP_URL);
  await first.close();

  const rotated = await startMockKeyapp({ signingKeyId: 'keyapp-v3' });
  process.env.BIFROST_KEYAPP_URL = `http://127.0.0.1:${rotated.port}`;
  pc.writeCache(process.env.BIFROST_KEYAPP_URL, cached);
  try {
    const r = await pc.refresh({ force: true });
    assert.equal(r.status, 'unchanged');
    assert.deepEqual(r.config, BUNDLE);
    const next = pc.readCache(process.env.BIFROST_KEYAPP_URL);
    assert.equal(next.signingKeyId, 'keyapp-v3');
    assert.equal(next.publicKeyPem.trim(), rotated.keys.publicKey.export({ type: 'spki', format: 'pem' }).trim());
    assert.equal(rotated.counts.bundle, 0);
    assert.equal(rotated.counts.key, 1);
    assert.equal((await pc.refresh({ force: true })).status, 'unchanged');
    assert.equal(rotated.counts.key, 1, 'verified replacement key was not pinned');
  } finally { await rotated.close(); }
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

test('policy and refusal notices never cross identities at one endpoint', async () => {
  const mock = await startMockKeyapp();
  reset(mock.port);
  const url = process.env.BIFROST_KEYAPP_URL;
  try {
    assert.equal((await pc.refresh({})).status, 'updated');
    pc.writeNotice(url, { status: 'bad-signature', message: 'identity A refusal' });
    const fileA = pc.cacheFile(url);
    process.env.BIFROST_VK = 'vk-test-identity-B';
    assert.equal(pc.loadCached(), null);
    assert.equal(pc.readNotice(url), null);
    assert.notEqual(pc.cacheFile(url), fileA);
    process.env.BIFROST_VK = 'vk-test-not-a-real-key';
    assert.deepEqual(pc.loadCached(), BUNDLE);
    assert.equal(pc.readNotice(url).message, 'identity A refusal');
    delete process.env.BIFROST_VK;
    assert.equal(pc.loadCached(), null);
    assert.equal(pc.readNotice(url), null);
  } finally { await mock.close(); }
});

test('an identity change during refresh cannot write policy or notices into the new identity', async () => {
  let switchIdentity = false;
  const mock = await startMockKeyapp({ mutate: m => {
    if (switchIdentity) process.env.BIFROST_VK = 'vk-test-identity-B';
    return m;
  } });
  reset(mock.port);
  const url = process.env.BIFROST_KEYAPP_URL;
  try {
    pc.writeNotice(url, { status: 'bad-signature', message: 'identity A refusal' });
    process.env.BIFROST_VK = 'vk-test-identity-B';
    pc.writeNotice(url, { status: 'bad-signature', message: 'identity B refusal' });
    process.env.BIFROST_VK = 'vk-test-not-a-real-key';
    switchIdentity = true;
    assert.equal((await pc.refreshAndRecord({ force: true })).status, 'updated');
    assert.equal(pc.loadCached(), null);
    assert.equal(pc.readNotice(url).message, 'identity B refusal');
    process.env.BIFROST_VK = 'vk-test-not-a-real-key';
    assert.deepEqual(pc.loadCached(), BUNDLE);
    assert.equal(pc.readNotice(url), null);
  } finally { await mock.close(); }
});

test('legacy and wrong-identity cache files are cold misses', async () => {
  const mock = await startMockKeyapp();
  reset(mock.port);
  const url = process.env.BIFROST_KEYAPP_URL;
  try {
    const dir = path.join(HOME, '.cache', 'bifrost-plugin');
    fs.mkdirSync(dir, { recursive: true });
    const legacyKey = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const legacy = { at: Date.now(), bundle: BUNDLE, configVersion: 'legacy' };
    fs.writeFileSync(path.join(dir, `plugin-config-${legacyKey}.json`), JSON.stringify(legacy));
    fs.writeFileSync(path.join(dir, `plugin-config-notice-${legacyKey}.json`), JSON.stringify({ message: 'legacy' }));
    assert.equal(pc.loadCached(), null);
    assert.equal(pc.readNotice(url), null);
    fs.writeFileSync(pc.cacheFile(url), JSON.stringify(legacy));
    assert.equal(pc.loadCached(), null, 'an unbound payload was trusted under a scoped name');
    assert.equal((await pc.refresh({})).status, 'updated');
    const identityA = fs.readFileSync(pc.cacheFile(url), 'utf8');
    assert.equal(identityA.includes(process.env.BIFROST_VK), false);
    process.env.BIFROST_VK = 'vk-test-identity-B';
    fs.writeFileSync(pc.cacheFile(url), identityA);
    assert.equal(pc.loadCached(), null, 'identity A payload was trusted under identity B path');
  } finally { await mock.close(); }
});

test('own offline policy survives while another identity or endpoint remains a cold miss', async () => {
  const mock = await startMockKeyapp();
  reset(mock.port);
  const url = process.env.BIFROST_KEYAPP_URL;
  assert.equal((await pc.refresh({})).status, 'updated');
  await mock.close();
  assert.deepEqual((await pc.refresh({ force: true, timeoutMs: 100 })).config, BUNDLE);
  process.env.BIFROST_VK = 'vk-test-identity-B';
  assert.equal((await pc.refresh({ force: true, timeoutMs: 100 })).config, null);
  process.env.BIFROST_VK = 'vk-test-not-a-real-key';
  process.env.BIFROST_KEYAPP_URL = url + '/other';
  assert.equal(pc.loadCached(), null);
  assert.equal((await pc.refresh({ force: true, timeoutMs: 100 })).config, null);
  process.env.BIFROST_KEYAPP_URL = url;
  assert.deepEqual(pc.loadCached(), BUNDLE);
});

test('late refresh refusal records a notice only for its captured identity', async () => {
  const mock = await startMockKeyapp({ mutate: m => {
    process.env.BIFROST_VK = 'vk-test-identity-B';
    return { ...m, signature: Buffer.alloc(64).toString('base64') };
  } });
  reset(mock.port);
  const url = process.env.BIFROST_KEYAPP_URL;
  try {
    assert.equal((await pc.refreshAndRecord({ force: true })).status, 'bad-signature');
    assert.equal(pc.readNotice(url), null);
    process.env.BIFROST_VK = 'vk-test-not-a-real-key';
    assert.equal(pc.readNotice(url).status, 'bad-signature');
  } finally { await mock.close(); }
});

test('a missing effective credential cannot read or create private cache files', () => {
  reset(1);
  const url = process.env.BIFROST_KEYAPP_URL;
  delete process.env.BIFROST_VK;
  assert.equal(pc.env().vk, '');
  assert.equal(pc.cacheFile(url), null);
  assert.equal(pc.noticeFile(url), null);
  pc.writeCache(url, { bundle: BUNDLE, configVersion: 'must-not-write' });
  pc.writeNotice(url, { status: 'bad-signature', message: 'must-not-write' });
  assert.equal(pc.loadCached(), null);
  assert.equal(pc.readNotice(url), null);
  const dir = path.join(HOME, '.cache', 'bifrost-plugin');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('an endpoint change during refresh cannot redirect the completed policy write', async () => {
  let original;
  const mock = await startMockKeyapp({ mutate: m => {
    process.env.BIFROST_KEYAPP_URL = original + '/other';
    return m;
  } });
  reset(mock.port);
  original = process.env.BIFROST_KEYAPP_URL;
  try {
    assert.equal((await pc.refreshAndRecord({ force: true })).status, 'updated');
    assert.equal(pc.loadCached(), null);
    process.env.BIFROST_KEYAPP_URL = original;
    assert.deepEqual(pc.loadCached(), BUNDLE);
  } finally { await mock.close(); }
});

for (const seed of ['legacy', 'identity A']) {
  test(`endpoint signing pin survives ${seed} migration into identity B`, async () => {
    const originalKeys = crypto.generateKeyPairSync('ed25519');
    const replacementKeys = crypto.generateKeyPairSync('ed25519');
    let replaced = false;
    let announced = false;
    const mock = await startMockKeyapp({ keys: originalKeys,
      servedKeys: () => replaced ? replacementKeys : originalKeys, mutate: m => {
      if (!replaced) return m;
      const fields = { ...m, signingKeyId: announced ? 'keyapp-v3' : m.signingKeyId };
      return { ...fields, signature: crypto.sign(null,
        Buffer.from(pc.canonicalManifestPayload(fields)), replacementKeys.privateKey).toString('base64') };
    } });
    reset(mock.port);
    const url = process.env.BIFROST_KEYAPP_URL;
    try {
      if (seed === 'legacy') {
        const dir = path.join(HOME, '.cache', 'bifrost-plugin');
        fs.mkdirSync(dir, { recursive: true });
        const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
        fs.writeFileSync(path.join(dir, `plugin-config-${key}.json`), JSON.stringify({
          keyappUrl: url, publicKeyPem: originalKeys.publicKey.export({ type: 'spki', format: 'pem' }),
          signingKeyId: 'keyapp-v2', bundle: { privateLegacy: true }, configVersion: 'legacy',
        }));
      } else {
        assert.equal((await pc.refresh({ force: true })).status, 'updated');
      }
      process.env.BIFROST_VK = 'vk-test-identity-B';
      assert.equal(pc.loadCached(), null);
      replaced = true;
      const rejected = await pc.refresh({ force: true });
      assert.equal(rejected.status, 'key-rotation-unannounced');
      assert.equal(rejected.config, null, 'legacy/other-user policy must never be reused');
      assert.equal(pc.loadCached(), null);
      replaced = false;
      const before = mock.counts.bundle;
      assert.equal((await pc.refresh({ force: true })).status, 'updated');
      assert.equal(mock.counts.bundle, before + 1, 'valid legacy pin must fetch a fresh private bundle');
      assert.deepEqual(pc.loadCached(), BUNDLE);
      replaced = true;
      announced = true;
      assert.equal((await pc.refresh({ force: true })).status, 'unchanged');
      assert.deepEqual(pc.loadCached(), BUNDLE);
    } finally { await mock.close(); }
  });
}

test('public signing trust is separated by endpoint and contains no private identity', async () => {
  const first = await startMockKeyapp();
  reset(first.port);
  assert.equal((await pc.refresh({ force: true })).status, 'updated');
  const firstUrl = process.env.BIFROST_KEYAPP_URL;
  await first.close();
  const other = await startMockKeyapp();
  process.env.BIFROST_KEYAPP_URL = `http://127.0.0.1:${other.port}`;
  try {
    assert.equal((await pc.refresh({ force: true })).status, 'updated');
    const dir = path.join(HOME, '.cache', 'bifrost-plugin');
    const pins = fs.readdirSync(dir).filter(name => name.startsWith('plugin-signing-pin-'));
    assert.equal(pins.length, 2);
    for (const file of pins) {
      const data = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.equal(data.includes(firstUrl), false);
      assert.equal(data.includes(process.env.BIFROST_KEYAPP_URL), false);
      assert.equal(data.includes(process.env.BIFROST_VK), false);
      assert.deepEqual(Object.keys(JSON.parse(data)).sort(), ['publicKeyPem', 'signingKeyId']);
    }
  } finally { await other.close(); }
});

for (const failure of ['competing pin', 'write failure']) {
  test(`a ${failure} cannot adopt unpinned private policy`, async () => {
    const mock = await startMockKeyapp();
    reset(mock.port);
    const originalWrite = fs.writeFileSync;
    const winner = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    let pinFile;
    fs.writeFileSync = (file, data, options) => {
      if (String(file).includes('plugin-signing-pin-')) {
        pinFile = file;
        if (failure === 'write failure') throw Object.assign(new Error('synthetic write failure'), { code: 'EACCES' });
        // Another first-use refresh won exclusive creation just before this write.
        originalWrite(file, JSON.stringify({ signingKeyId: 'keyapp-v2', publicKeyPem: winner }), options);
      }
      return originalWrite(file, data, options);
    };
    try {
      const r = await pc.refresh({ force: true });
      assert.equal(r.status, 'no-public-key');
      assert.equal(r.config, null);
      assert.equal(pc.loadCached(), null);
      assert.ok(pinFile);
      if (failure === 'competing pin') assert.equal(JSON.parse(fs.readFileSync(pinFile)).publicKeyPem, winner);
    } finally { fs.writeFileSync = originalWrite; await mock.close(); }
  });
}

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

// Since 1.9 most installs carry the key only as a plugin option. Delivery used to need
// BIFROST_KEYAPP_URL + BIFROST_VK in the shell, so nobody received config at all.
test('env(): plugin options alone enable delivery via the gateway origin', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['BIFROST_KEYAPP_URL', 'BIFROST_VK', 'BIFROST_URL', 'BIFROST_PLUGIN_CONFIG', 'CLAUDE_PLUGIN_OPTION_KEYAPP_URL']) delete process.env[k];
    process.env.CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY = 'sk-bf-option-only';
    process.env.CLAUDE_PLUGIN_OPTION_GATEWAY_URL = 'https://gw.example.test/mcp';
    let e = pc.env();
    assert.equal(e.vk, 'sk-bf-option-only');
    assert.equal(e.keyappUrl, 'https://gw.example.test');
    assert.equal(e.enabled, true);

    process.env.CLAUDE_PLUGIN_OPTION_KEYAPP_URL = 'https://keys.example.test/';
    e = pc.env();
    assert.equal(e.keyappUrl, 'https://keys.example.test');

    // A shell key without a keyapp URL never rides along to an option-paired gateway.
    delete process.env.CLAUDE_PLUGIN_OPTION_KEYAPP_URL;
    process.env.BIFROST_VK = 'sk-bf-shell';
    assert.equal(pc.env().vk, 'sk-bf-option-only');

    // Cleartext keyapp is refused unless loopback.
    delete process.env.BIFROST_VK;
    process.env.BIFROST_KEYAPP_URL = 'http://keys.example.test';
    assert.equal(pc.env().keyappUrl, '');
    process.env.BIFROST_KEYAPP_URL = 'http://127.0.0.1:9';
    assert.equal(pc.env().keyappUrl, 'http://127.0.0.1:9');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
