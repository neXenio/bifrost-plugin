'use strict';
// Signed plugin-config client — the plugin half of keyapp's /plugin-config/* contract.
//
// keyapp serves an Ed25519-signed, content-addressed manifest + bundle pair describing
// the EFFECTIVE per-user config (admin policy already deep-merged with the user's
// non-locked overrides, server-side — we do NOT re-merge). This module fetches it,
// verifies it, caches it, and hands session-start.cjs a config object to apply.
//
// Server-side source of truth (read-only reference, keyapp/lib/plugincfg.js):
//   canonicalManifestPayload  keyapp/lib/plugincfg.js:102-104
//   signManifest              keyapp/lib/plugincfg.js:106-110
//   SCHEMA_VERSION = 1        keyapp/lib/plugincfg.js:18
//   MIN_BOOTSTRAP_VERSION     keyapp/lib/plugincfg.js:19
//   SIGNING_KEY_ID            keyapp/lib/plugincfg.js:17
//
// SECURITY POSTURE — fail closed. An unverifiable, absent, tampered, or hash-mismatched
// payload means we use NOTHING from the server on this pass: we fall back to the
// last cached-and-previously-verified config, or to no config at all. A bundle is only
// ever written to the cache AFTER both the Ed25519 signature and the sha256 check pass,
// so anything in the cache is by construction previously-verified.
//
// Env:
//   BIFROST_KEYAPP_URL          keyapp base URL (else `keyapp_url` option, else gateway origin)
//   BIFROST_VK                  virtual key, sent as x-bf-vk (else any source gateway.cjs knows)
//   BIFROST_PLUGIN_CONFIG=0     kill switch — disables this entire path
//   BIFROST_PLUGIN_CONFIG_TTL_MS  skip even the manifest check this long after a
//                                 successful refresh (default 15min)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const gw = require('./gateway.cjs');
const { scopeKey } = require('./cache-scope.cjs');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// Must match keyapp/lib/plugincfg.js:18 — a manifest declaring any other schemaVersion
// is a contract we do not understand, so we refuse it rather than guess.
const SUPPORTED_SCHEMA_VERSION = 1;

// ---- env ----------------------------------------------------------------

// Keyapp base: BIFROST_KEYAPP_URL, else the `keyapp_url` option; the key then is
// BIFROST_VK or whatever gateway.cjs resolves. Without either, the gateway's origin,
// paired with the key gateway.cjs issued for that same gateway, so a key never goes to
// a host it was not issued for. Cleartext is refused except on loopback.
function safeBase(u) {
  try {
    const x = new URL(u);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
    return x.protocol === 'https:' || (x.protocol === 'http:' && loopback) ? u.replace(/\/+$/, '') : '';
  } catch (_) { return ''; }
}

function env() {
  const enabled = process.env.BIFROST_PLUGIN_CONFIG !== '0';
  const explicit = (process.env.BIFROST_KEYAPP_URL || gw.pluginOption('keyapp_url') || '').trim();
  if (explicit) {
    const vk = (process.env.BIFROST_VK || '').trim() || gw.env().vk;
    return { keyappUrl: safeBase(explicit), vk, enabled };
  }
  const g = gw.env();
  let origin = '';
  if (g.url && g.vk) {
    try { origin = new URL(g.url).origin; } catch (_) {}
  }
  return { keyappUrl: safeBase(origin), vk: origin ? g.vk : '', enabled };
}

function ttlMs() {
  const v = parseInt(process.env.BIFROST_PLUGIN_CONFIG_TTL_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_MS;
}

// This plugin's own version — the "bootstrap version" keyapp gates on via
// minBootstrapVersion. Read from package.json so it can never drift from the release.
function pluginVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    ).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

// Numeric-tuple compare, prerelease/build metadata ignored. Returns -1 | 0 | 1.
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '0')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- canonicalization (MUST mirror keyapp byte-for-byte) -----------------

// Exact mirror of keyapp/lib/plugincfg.js:102-104. Key order is load-bearing: this is
// a JSON.stringify of an object literal, so the five keys are serialized in exactly
// this declaration order. Changing the order here silently breaks every signature.
// The signature covers the whole integrity/version contract (not just sha256), so a
// tampered configVersion / schemaVersion / minBootstrapVersion / signingKeyId is caught.
function canonicalManifestPayload({ schemaVersion, minBootstrapVersion, configVersion, sha256, signingKeyId }) {
  return JSON.stringify({ schemaVersion, minBootstrapVersion, configVersion, sha256, signingKeyId });
}

// keyapp signs with crypto.sign(null, ...) over the canonical payload and base64-encodes
// it (plugincfg.js:106-110). `null` is the correct algorithm arg for Ed25519 in Node core.
// Returns a plain boolean — any malformed key/signature is a verification FAILURE, never
// an exception that a caller might mistake for something else.
function verifyManifest(manifest, publicKeyPem) {
  try {
    if (!manifest || !manifest.signature || !publicKeyPem) return false;
    const payload = canonicalManifestPayload(manifest);
    return crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(String(manifest.signature), 'base64')
    );
  } catch (_) {
    return false;
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- http ---------------------------------------------------------------

// One GET. Resolves {status, headers, body:Buffer} or null on any transport error /
// timeout. Never throws and never rejects — callers degrade to cache.
function get(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        headers: headers || {},
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () =>
          resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchManifest(keyappUrl, vk, timeoutMs) {
  const r = await get(`${keyappUrl}/plugin-config/manifest.json`, { 'x-bf-vk': vk }, timeoutMs);
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch (_) { return null; }
}

// 503 here means keyapp has no signing key configured — there is nothing to trust, so
// we return null and the caller falls back to cache (fail closed).
async function fetchPublicKey(keyappUrl, timeoutMs) {
  const r = await get(`${keyappUrl}/plugin-config/public-key`, {}, timeoutMs);
  if (!r || r.status !== 200) return null;
  const pem = r.body.toString('utf8').trim();
  return /BEGIN PUBLIC KEY/.test(pem) ? pem : null;
}

// A content-addressed URL you don't hash-check is just a URL. Fetch, then verify
// sha256(body) === the sha the SIGNED manifest committed to, BEFORE parsing.
// bundleUrl is server-supplied, so it is constrained to a same-origin path — a manifest
// that (somehow) pointed at another host must not cause us to fetch from it.
async function fetchBundle(keyappUrl, bundleUrl, expectedSha256, timeoutMs) {
  if (typeof bundleUrl !== 'string' || !bundleUrl.startsWith('/')) return null;
  const r = await get(`${keyappUrl}${bundleUrl}`, {}, timeoutMs);
  if (!r || r.status !== 200) return null;
  if (sha256Hex(r.body) !== expectedSha256) return null; // tampered or mis-served body
  try { return JSON.parse(r.body.toString('utf8')); } catch (_) { return null; }
}

// ---- cache --------------------------------------------------------------

// Keyed by keyapp origin so two gateways never share (or clobber) each other's pinned
// signing key and config.
// The full keyapp endpoint AND credential now partition that cache: users of one
// gateway must not share per-user policy or notices. Legacy origin-only files are
// deliberately ignored because their owning identity cannot be recovered safely.
function cacheFile(keyappUrl, vk = env().vk) {
  const key = scopeKey(keyappUrl, vk);
  return key ? path.join(CACHE_DIR, `plugin-config-v2-${key}.json`) : null;
}

// Everything in here passed signature + sha256 verification before it was written.
function readCache(keyappUrl, vk = env().vk) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(keyappUrl, vk), 'utf8'));
    if (c && c.cacheScope === scopeKey(keyappUrl, vk) && c.bundle && c.configVersion) return c;
  } catch (_) {}
  return null;
}

function writeCache(keyappUrl, entry, vk = env().vk) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const f = cacheFile(keyappUrl, vk);
    if (!f) return;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...entry, cacheScope: scopeKey(keyappUrl, vk) }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, f); // atomic — a torn cache file would read as "no config"
  } catch (_) {}
}

// Public signing trust belongs to the endpoint, not a private policy identity.
// Keep one immutable pin per signingKeyId so account switches and announced
// rotations cannot silently replace a key already trusted under that identifier.
function publicPinFile(keyappUrl, signingKeyId) {
  if (typeof signingKeyId !== 'string' || !signingKeyId) throw new Error('Missing signing key identity');
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(['bifrost-public-pin-v1', new URL(keyappUrl).href, signingKeyId]))
    .digest('hex');
  return path.join(CACHE_DIR, `plugin-signing-pin-${digest}.json`);
}

function readPublicPin(keyappUrl, signingKeyId, cached) {
  const valid = pin => {
    try {
      return pin && pin.signingKeyId === signingKeyId &&
        typeof signingKeyId === 'string' && signingKeyId.length > 0 &&
        typeof pin.publicKeyPem === 'string' &&
        crypto.createPublicKey(pin.publicKeyPem).asymmetricKeyType === 'ed25519'
        ? pin.publicKeyPem : null;
    } catch (_) { return null; }
  };
  try {
    const pin = valid(JSON.parse(fs.readFileSync(publicPinFile(keyappUrl, signingKeyId), 'utf8')));
    if (pin) return pin;
  } catch (_) {}
  // Only public key material is recovered from the old verified cache. Its
  // per-user bundle and notices never become data for the new identity.
  try {
    const legacyKey = crypto.createHash('sha256').update(keyappUrl).digest('hex').slice(0, 12);
    const legacy = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `plugin-config-${legacyKey}.json`), 'utf8'));
    if (new URL(legacy.keyappUrl).href === new URL(keyappUrl).href) {
      const pin = valid(legacy);
      if (pin) return pin;
    }
  } catch (_) {}
  return valid(cached);
}

function writePublicPin(keyappUrl, signingKeyId, publicKeyPem) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(publicPinFile(keyappUrl, signingKeyId),
      JSON.stringify({ signingKeyId, publicKeyPem }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (_) {
    // A concurrent refresh may already have pinned this ID. Never overwrite it.
    return readPublicPin(keyappUrl, signingKeyId, null) === publicKeyPem;
  }
}

// ---- notices ------------------------------------------------------------
// refresh() runs in a DETACHED worker whose stdout goes nowhere, so a refusal it needs
// the user to see (unannounced key rotation, plugin too old) is persisted here and
// surfaced by the next SessionStart. Same marker pattern as auto-setup-result.json.
// Cleared on any successful refresh so a fixed problem stops nagging.

function noticeFile(keyappUrl, vk = env().vk) {
  const key = scopeKey(keyappUrl, vk);
  return key ? path.join(CACHE_DIR, `plugin-config-notice-v2-${key}.json`) : null;
}

function readNotice(keyappUrl, vk = env().vk) {
  try {
    const notice = JSON.parse(fs.readFileSync(noticeFile(keyappUrl, vk), 'utf8'));
    return notice && notice.cacheScope === scopeKey(keyappUrl, vk) ? notice : null;
  } catch (_) { return null; }
}

function writeNotice(keyappUrl, obj, vk = env().vk) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = noticeFile(keyappUrl, vk);
    if (!file) return;
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), ...obj, cacheScope: scopeKey(keyappUrl, vk) }), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function clearNotice(keyappUrl, vk = env().vk) {
  try { fs.unlinkSync(noticeFile(keyappUrl, vk)); } catch (_) {}
}

// ---- refresh ------------------------------------------------------------

// Full fetch -> verify -> apply-to-cache pass. Returns a result whose `status` explains
// what happened; `config` is the bundle now in effect (possibly the cached one).
//
// Statuses: disabled | not-configured | cached-fresh | unchanged | updated |
//           no-public-key | bad-signature | key-rotation-unannounced |
//           unsupported-schema | bootstrap-too-old | bundle-unavailable | unreachable
//
// Every failure path leaves the existing verified cache untouched.
async function refresh({ timeoutMs = DEFAULT_TIMEOUT_MS, force = false } = {}, credential = env()) {
  const { keyappUrl, vk, enabled } = credential;
  if (!enabled) return { status: 'disabled', config: null };
  if (!keyappUrl || !vk) return { status: 'not-configured', config: null };

  const cached = readCache(keyappUrl, vk);

  // Skip the network entirely while the cache is inside its TTL.
  if (!force && cached && typeof cached.at === 'number' && Date.now() - cached.at < ttlMs()) {
    return { status: 'cached-fresh', config: cached.bundle, configVersion: cached.configVersion };
  }

  const manifest = await fetchManifest(keyappUrl, vk, timeoutMs);
  if (!manifest) {
    // Gateway down / 401 / garbage. Degrade to the last verified config, silently.
    return { status: 'unreachable', config: cached ? cached.bundle : null };
  }

  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      status: 'unsupported-schema',
      config: cached ? cached.bundle : null,
      message:
        `[bifrost] plugin-config schemaVersion ${manifest.schemaVersion} is not supported ` +
        `(this plugin speaks ${SUPPORTED_SCHEMA_VERSION}). Upgrade bifrost-plugin.`,
    };
  }

  // The server can demand a newer plugin than we are. Refuse cleanly and tell the user
  // to upgrade — do NOT half-apply a config we may not understand.
  const mine = pluginVersion();
  if (manifest.minBootstrapVersion && compareVersions(mine, manifest.minBootstrapVersion) < 0) {
    return {
      status: 'bootstrap-too-old',
      config: cached ? cached.bundle : null,
      message:
        `[bifrost] the gateway requires bifrost-plugin >= ${manifest.minBootstrapVersion} ` +
        `but this is ${mine}. Plugin config was NOT applied. Update the plugin ` +
        '(`/plugin` → update bifrost, or `npx bifrost-plugin-install`).',
    };
  }

  // --- signing key: TOFU pin, keyed by signingKeyId ---
  // Same keyId as pinned -> verify with the PINNED key and never re-fetch. That means a
  // silently-swapped server key (rotated without bumping signingKeyId) fails the
  // signature check instead of being trusted — which is exactly the point of pinning.
  const pinned = readPublicPin(keyappUrl, manifest.signingKeyId, cached);
  let publicKeyPem = pinned;
  if (!publicKeyPem) {
    publicKeyPem = await fetchPublicKey(keyappUrl, timeoutMs);
    if (!publicKeyPem) {
      return { status: 'no-public-key', config: cached ? cached.bundle : null };
    }
  }

  if (!verifyManifest(manifest, publicKeyPem)) {
    // Distinguish "someone tampered with the manifest" from "the server rotated its key
    // without announcing it via signingKeyId". Both are refusals; only one is worth
    // shouting about, and we only pay for the extra request on the failure path.
    if (pinned) {
      const served = await fetchPublicKey(keyappUrl, timeoutMs);
      if (served && served.trim() !== pinned.trim()) {
        return {
          status: 'key-rotation-unannounced',
          config: cached ? cached.bundle : null,
          message:
            `[bifrost] REFUSING plugin config: the gateway is serving a DIFFERENT signing key ` +
            `under the same signingKeyId "${manifest.signingKeyId}". A genuine key rotation must ` +
            'change signingKeyId. Keeping the last verified config. If this rotation was intended, ' +
            'ask the gateway operator to publish a new signingKeyId.',
        };
      }
    }
    return {
      status: 'bad-signature',
      config: cached ? cached.bundle : null,
      message: '[bifrost] REFUSING plugin config: manifest signature did not verify. Nothing applied.',
    };
  }

  // Unchanged config -> no key fetch, no bundle fetch. Just bump the cache timestamp
  // so the TTL short-circuit above covers the next call.
  // This optimization applies only after validation, with an unchanged pinned key.
  // An announced rotation above fetches and verifies its new key, which must be pinned
  // even when the signed bundle content itself has not changed.
  if (cached && cached.configVersion === manifest.configVersion && cached.sha256 === manifest.sha256) {
    if (!writePublicPin(keyappUrl, manifest.signingKeyId, publicKeyPem)) {
      return { status: 'no-public-key', config: cached.bundle };
    }
    writeCache(keyappUrl, {
      ...cached, at: Date.now(), signingKeyId: manifest.signingKeyId, publicKeyPem,
    }, vk);
    return { status: 'unchanged', config: cached.bundle, configVersion: cached.configVersion };
  }

  // Signature is good — the manifest's sha256 is now a trusted commitment to the bundle bytes.
  const bundle = await fetchBundle(keyappUrl, manifest.bundleUrl, manifest.sha256, timeoutMs);
  if (!bundle) {
    // 404, transport error, or sha256 mismatch. Never partially apply.
    return { status: 'bundle-unavailable', config: cached ? cached.bundle : null };
  }

  if (!writePublicPin(keyappUrl, manifest.signingKeyId, publicKeyPem)) {
    return { status: 'no-public-key', config: cached ? cached.bundle : null };
  }
  writeCache(keyappUrl, {
    at: Date.now(),
    configVersion: manifest.configVersion,
    sha256: manifest.sha256,
    signingKeyId: manifest.signingKeyId,
    publicKeyPem,
    bundle,
  }, vk);

  return { status: 'updated', config: bundle, configVersion: manifest.configVersion };
}

// What the detached background worker calls: refresh, then persist any user-visible
// refusal so the NEXT session start can surface it (this process has no usable stdout).
// Statuses that mean "we simply have nothing new" (gateway down, not configured) are not
// worth nagging about — the session already degraded silently to cache, as designed.
const NOTICE_STATUSES = new Set([
  'bootstrap-too-old',
  'key-rotation-unannounced',
  'bad-signature',
  'unsupported-schema',
]);

async function refreshAndRecord(opts) {
  const credential = env();
  const { keyappUrl, vk } = credential;
  const r = await refresh(opts, credential);
  if (!keyappUrl) return r;
  if (NOTICE_STATUSES.has(r.status)) writeNotice(keyappUrl, { status: r.status, message: r.message }, vk);
  else if (r.status === 'updated' || r.status === 'unchanged' || r.status === 'cached-fresh') clearNotice(keyappUrl, vk);
  return r;
}

// Sub-millisecond, zero network. This is what SessionStart calls: it only ever returns
// a config that was fully verified at the time it was cached.
function loadCached() {
  const { keyappUrl, vk, enabled } = env();
  if (!enabled || !keyappUrl || !vk) return null;
  const c = readCache(keyappUrl, vk);
  return c ? c.bundle : null;
}

// ---- applying the config ------------------------------------------------

// hooks: { <hookId>: { enabled, fields: {...}, lockedFields: [...] } }  (keyapp/lib/hooks.js)
//
// Resolution order for one field of one hook:
//   hook absent or disabled  -> local env, else default   (server has no opinion)
//   field in lockedFields    -> SERVER value wins, always (admin lock; not user-overridable)
//   otherwise                -> local env if set, else server value, else default
//
// The server bundle is already the effective per-user config (admin policy deep-merged
// with the user's non-locked overrides, keyapp/lib/plugincfg.js:127-147), so the only
// merge left to do here is against this machine's env vars.
function hookField(config, hookId, field, envName, dflt) {
  const hook = config && config.hooks && config.hooks[hookId];
  const envVal = envName && process.env[envName] !== undefined ? process.env[envName] : undefined;

  if (!hook || !hook.enabled) return envVal !== undefined ? envVal : dflt;

  const locked = Array.isArray(hook.lockedFields) && hook.lockedFields.includes(field);
  const serverVal = hook.fields && Object.prototype.hasOwnProperty.call(hook.fields, field)
    ? hook.fields[field]
    : undefined;

  if (locked && serverVal !== undefined) return serverVal;
  if (envVal !== undefined) return envVal;
  if (serverVal !== undefined) return serverVal;
  return dflt;
}

// Same resolution, coerced to a boolean. Accepts the plugin's existing "0"/"1" env
// convention as well as real booleans coming from the bundle.
function hookFlag(config, hookId, field, envName, dflt) {
  const v = hookField(config, hookId, field, envName, dflt);
  if (typeof v === 'boolean') return v;
  if (v === '0' || v === 0 || v === 'false') return false;
  if (v === '1' || v === 1 || v === 'true') return true;
  return !!dflt;
}

// skills: [{ id, state: 'always_on'|'available'|'off', optedIn?: bool }]
// tools:  [{ client, tool, state }]
//
// 'off'        — suppressed for this user; must not be used.
// 'always_on'  — not user-disableable.
// 'available'  — default. If the user has an explicit opt-out (optedIn === false), it is
//                suppressed too; `optedIn` is only present when the user set it.
function partitionSkills(config) {
  const skills = (config && Array.isArray(config.skills)) ? config.skills : [];
  const off = [];
  const alwaysOn = [];
  for (const s of skills) {
    if (!s || !s.id) continue;
    if (s.state === 'off') off.push(s.id);
    else if (s.state === 'always_on') alwaysOn.push(s.id);
    else if (s.state === 'available' && s.optedIn === false) off.push(s.id);
  }
  return { off, alwaysOn };
}

function offTools(config) {
  const tools = (config && Array.isArray(config.tools)) ? config.tools : [];
  return tools
    .filter((t) => t && t.state === 'off' && t.client && t.tool)
    .map((t) => `${t.client}.${t.tool}`);
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  env,
  pluginVersion,
  compareVersions,
  canonicalManifestPayload,
  verifyManifest,
  sha256Hex,
  fetchManifest,
  fetchPublicKey,
  fetchBundle,
  cacheFile,
  readCache,
  writeCache,
  noticeFile,
  readNotice,
  writeNotice,
  clearNotice,
  refresh,
  refreshAndRecord,
  loadCached,
  hookField,
  hookFlag,
  partitionSkills,
  offTools,
};
