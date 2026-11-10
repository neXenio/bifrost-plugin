'use strict';

const crypto = require('crypto');

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

module.exports = { scopeKey };
