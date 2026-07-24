import fs from 'node:fs';
import path from 'node:path';

/**
 * Claim → virtual-key lookup, deny-by-default.
 *
 * The map file is JSON: { "users": { "<email-or-sub>": "vk_..." } }.
 * Keys are matched case-insensitively; lookup tries the `email` claim first,
 * then `sub`. The `email` claim is only trusted when the token also carries
 * `email_verified: true` — an unverified (self-asserted) address must never
 * resolve to another user's key, so it falls through to `sub`. An
 * authenticated user with no mapping gets `null` — callers must treat that as a
 * hard deny, never fall back to a shared key.
 *
 * The file may be hand-maintained or written by the sync job
 * (src/sync-vk-map.mjs), which replaces it atomically via rename. We watch
 * the parent directory rather than the file itself because a rename swaps
 * the inode and would silently detach a file-level watcher. Watching is
 * best effort — some mounts don't emit events; `reload()` is exposed for
 * explicit refresh and a restart always picks up changes. A malformed edit
 * keeps the last good map.
 */
export function createVkMap(mapPath, { logger } = {}) {
  let users = {};

  function reload() {
    const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (!parsed || typeof parsed.users !== 'object' || parsed.users === null) {
      throw new Error(`VK map ${mapPath} must be an object with a "users" key`);
    }
    users = Object.fromEntries(
      Object.entries(parsed.users).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return Object.keys(users).length;
  }

  // Initial load is strict: a broken map at startup is a config error.
  reload();

  const mapFile = path.basename(mapPath);
  let watcher;
  let reloadTimer;
  try {
    watcher = fs.watch(path.dirname(mapPath), (_event, filename) => {
      if (filename && filename !== mapFile) return;
      // Debounce: a write or rename can emit several events back to back.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        try {
          const n = reload();
          logger?.info({ entries: n }, 'vk map reloaded');
        } catch (err) {
          logger?.error({ err: err.message }, 'vk map reload failed — keeping previous map');
        }
      }, 50);
    });
  } catch {
    // Watch is best-effort; explicit reload()/restart still works.
  }

  return {
    reload,
    lookup(claims) {
      // Only a verified email may key the map; an unverified address is ignored
      // so it can never resolve to another user's virtual key.
      const email = claims.email_verified === true && typeof claims.email === 'string'
        ? claims.email.toLowerCase()
        : undefined;
      const sub = typeof claims.sub === 'string' ? claims.sub.toLowerCase() : undefined;
      return (email && users[email]) ?? (sub && users[sub]) ?? null;
    },
    size() {
      return Object.keys(users).length;
    },
    close() {
      clearTimeout(reloadTimer);
      watcher?.close();
    },
  };
}
