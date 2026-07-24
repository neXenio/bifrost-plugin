import fs from 'node:fs';
import path from 'node:path';

/**
 * Periodic export: Bifrost governance API -> vk-map.json.
 *
 * Bifrost's SSO user provisioning already assigns each user a virtual key;
 * this job makes Bifrost the single source of truth by exporting that
 * user->VK table into the file the bridge serves lookups from. The bridge's
 * hot-reload picks up the new file, so the admin credential only ever lives
 * here — never in the request path.
 *
 * The exact response shape of GET /api/governance/virtual-keys varies by
 * Bifrost version/tier, so extraction tries common field locations and can
 * be pinned with VK_SYNC_EMAIL_PATH / VK_SYNC_VALUE_PATH (dot paths into
 * each list item) once you've inspected your deployment's real response.
 */

const EMAIL_PATHS = ['user.email', 'user_email', 'email', 'user.username'];
const VALUE_PATHS = ['value', 'key', 'vk', 'virtual_key'];

export function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function firstString(item, paths) {
  for (const p of paths) {
    const v = getPath(item, p);
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export function extractUsers(payload, { emailPath, valuePath } = {}) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.virtual_keys ?? payload?.data ?? payload?.keys;
  if (!Array.isArray(list)) {
    throw new Error(
      'unrecognized governance API response shape — expected an array (or {virtual_keys|data|keys: [...]})',
    );
  }

  const users = {};
  let skipped = 0;
  for (const item of list) {
    const email = emailPath ? getPath(item, emailPath) : firstString(item, EMAIL_PATHS);
    const value = valuePath ? getPath(item, valuePath) : firstString(item, VALUE_PATHS);
    if (typeof email !== 'string' || !email || typeof value !== 'string' || !value || item.is_active === false) {
      skipped++;
      continue;
    }
    users[email.toLowerCase()] = value;
  }
  return { users, skipped, total: list.length };
}

function authHeaders(token, headerName = 'authorization') {
  return headerName === 'authorization'
    ? { authorization: `Bearer ${token}` }
    : { [headerName]: token };
}

export async function syncOnce({
  adminUrl,
  adminToken,
  authHeaderName,
  mapPath,
  emailPath,
  valuePath,
  allowEmpty = false,
  dryRun = false,
  fetchImpl = fetch,
  log = console,
}) {
  const url = `${adminUrl.replace(/\/$/, '')}/api/governance/virtual-keys`;
  const res = await fetchImpl(url, { headers: authHeaders(adminToken, authHeaderName) });
  if (!res.ok) {
    throw new Error(`governance API returned ${res.status} for ${url}`);
  }

  const { users, skipped, total } = extractUsers(await res.json(), { emailPath, valuePath });
  const mapped = Object.keys(users).length;
  if (mapped === 0 && !allowEmpty) {
    // An empty export is far more likely an API/shape problem than a real
    // zero-user gateway — refuse to clobber a working map with it.
    throw new Error(
      `extracted 0 user->VK entries (${total} keys in response, ${skipped} skipped) — ` +
        'check VK_SYNC_EMAIL_PATH / VK_SYNC_VALUE_PATH against the real response; pass --allow-empty to force',
    );
  }

  const next = JSON.stringify({ users }, null, 2) + '\n';
  let current = null;
  try {
    current = fs.readFileSync(mapPath, 'utf8');
  } catch {}

  if (current === next) {
    log.info?.(`vk-map sync: unchanged (${mapped} users, ${skipped} skipped)`);
    return { mapped, skipped, changed: false };
  }
  if (dryRun) {
    log.info?.(`vk-map sync (dry-run): would write ${mapped} users (${skipped} skipped) to ${mapPath}`);
    return { mapped, skipped, changed: true };
  }

  // Atomic replace so the bridge never reads a half-written map.
  const tmp = path.join(path.dirname(mapPath), `.vk-map.tmp-${process.pid}`);
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, mapPath);
  log.info?.(`vk-map sync: wrote ${mapped} users (${skipped} skipped) to ${mapPath}`);
  return { mapped, skipped, changed: true };
}

export function loadSyncConfigFromEnv(env = process.env) {
  const required = ['BIFROST_ADMIN_URL', 'BIFROST_ADMIN_TOKEN', 'VK_MAP_PATH'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`);
  }
  return {
    adminUrl: env.BIFROST_ADMIN_URL,
    adminToken: env.BIFROST_ADMIN_TOKEN,
    authHeaderName: env.BIFROST_ADMIN_AUTH_HEADER ?? 'authorization',
    mapPath: env.VK_MAP_PATH,
    emailPath: env.VK_SYNC_EMAIL_PATH || undefined,
    valuePath: env.VK_SYNC_VALUE_PATH || undefined,
    intervalSeconds: Number(env.SYNC_INTERVAL_SECONDS ?? 0),
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  let config;
  try {
    config = loadSyncConfigFromEnv();
  } catch (err) {
    console.error(`vk-map sync failed to start: ${err.message}`);
    process.exit(1);
  }
  const opts = {
    ...config,
    allowEmpty: args.includes('--allow-empty'),
    dryRun: args.includes('--dry-run'),
    log: console,
  };

  if (config.intervalSeconds > 0) {
    // Loop mode (e.g. compose sidecar). Failures are logged and retried on
    // the next tick — the bridge keeps serving the last good map meanwhile.
    const tick = () =>
      syncOnce(opts).catch((err) => console.error(`vk-map sync failed: ${err.message}`));
    await tick();
    setInterval(tick, config.intervalSeconds * 1000);
  } else {
    // One-shot mode (cron / systemd timer): nonzero exit on failure.
    syncOnce(opts).catch((err) => {
      console.error(`vk-map sync failed: ${err.message}`);
      process.exit(1);
    });
  }
}
