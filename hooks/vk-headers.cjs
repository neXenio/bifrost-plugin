'use strict';
// MCP headersHelper for the plugin's `bifrost` server (wired in .mcp.json).
//
// Supplies the x-bf-vk header from the key cached by the opt-in auto-login flow
// (hooks/lib/key-cache.cjs). The cache file is the only possible source: Claude Code
// strips every credential-looking variable (*KEY*, *TOKEN*, *SECRET*, *AUTH*) from a
// plugin helper's environment, and rejects ${user_config.*} inside headersHelper.
//
// Contract with Claude Code: write exactly one JSON object of string pairs to stdout
// and nothing else. Dynamic headers override static ones of the same name, so the
// empty object `{}` is the important case — it leaves the static
// `x-bf-vk: ${user_config.virtual_key}` header untouched for anyone who configured
// a key by hand. The cached key is only offered to the gateway it was issued for
// (CLAUDE_CODE_MCP_SERVER_URL, compared with trailing slashes normalized), never to
// whatever URL the server happens to point at today.
//
// Never throws, never prints the key anywhere but that one stdout object, no network.

let out = {};
try {
  const keyCache = require('./lib/key-cache.cjs');
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
  const target = norm(process.env.CLAUDE_CODE_MCP_SERVER_URL);
  const cached = keyCache.read();
  if (cached && target && norm(cached.url) === target) {
    // Never hand the key to a cleartext connection, except to a loopback gateway.
    const u = new URL(target);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) out = { 'x-bf-vk': cached.vk };
  }
} catch (_) {
  out = {};
}
process.stdout.write(JSON.stringify(out));
