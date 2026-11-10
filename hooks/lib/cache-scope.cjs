'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// Cache identity is the full endpoint plus its credential, never just the origin.
// Versioned domain separation makes old, ambiguous cache names cold misses. Only the
// digest may be persisted; callers keep the credential in their operation snapshot.
function scopeKey(endpoint, credential) {
  try {
    if (typeof endpoint !== 'string' || typeof credential !== 'string' ||
        !endpoint.trim() || !credential.trim()) return null;
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    return crypto.createHash('sha256')
      .update(JSON.stringify(['bifrost-cache-identity-v1', url.href, credential]))
      .digest('hex');
  } catch (_) { return null; }
}

function scopedDirectory(endpoint, credential, home = os.homedir()) {
  const scope = scopeKey(endpoint, credential);
  return scope ? path.join(home, '.cache', 'bifrost-plugin', `identity-${scope}`) : null;
}

function injectScope(project, endpoint, credential) {
  const identity = scopeKey(endpoint, credential);
  return identity ? crypto.createHash('sha256').update(JSON.stringify([identity, project])).digest('hex') : null;
}

function injectFile(project, endpoint, credential, home = os.homedir()) {
  const dir = scopedDirectory(endpoint, credential, home);
  if (!dir) return null;
  const label = (path.basename(project) || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(project).digest('hex').slice(0, 12);
  return path.join(dir, `inject-${label}-${digest}.json`);
}

module.exports = { scopeKey, scopedDirectory, injectScope, injectFile };
