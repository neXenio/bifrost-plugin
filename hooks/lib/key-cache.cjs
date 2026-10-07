'use strict';
// Cached virtual key written by the opt-in auto-login flow (hooks/auto-setup.cjs).
//
// Stored as JSON {url, vk, at} rather than a bare key, because a gateway URL and the
// key that authenticates to it are ONE credential (see gateway.cjs env()). Recording
// which gateway the key was issued for lets every reader refuse to send it anywhere
// else.
//
// Two readers: gateway.cjs env() for the hooks, and hooks/vk-headers.cjs, the MCP
// headersHelper. The helper is why this has to be a file at all — Claude Code strips
// every *KEY*/*TOKEN*/*SECRET*/*AUTH* variable from a plugin helper's environment and
// refuses ${user_config.*} in headersHelper, so there is no other channel to it.
//
// The path is resolved at call time, not at load time, so a test (or anything else)
// that points HOME elsewhere gets its own cache. Directory 0700, file 0600, written
// via tmp + rename so a concurrent reader never sees half a file. Never throws.

const fs = require('fs');
const os = require('os');
const path = require('path');

function cacheDir() {
  return path.join(os.homedir(), '.cache', 'bifrost-plugin');
}

function keyFile() {
  return path.join(cacheDir(), 'vk');
}

// Null on anything missing or malformed — a reader treats that as "no cached key".
function read() {
  try {
    const c = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
    if (!c || typeof c.url !== 'string' || typeof c.vk !== 'string') return null;
    const url = c.url.trim();
    const vk = c.vk.trim();
    if (!url || !vk) return null;
    return { url, vk, at: typeof c.at === 'number' ? c.at : 0 };
  } catch (_) {
    return null;
  }
}

// Returns true on success. The tmp file is created 0600 from the start, so the key is
// never readable by anyone else even for the instant before the rename.
function write(url, vk) {
  const dir = cacheDir();
  const tmp = path.join(dir, `vk.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    fs.writeFileSync(tmp, JSON.stringify({ url, vk, at: Date.now() }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, keyFile());
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function clear() {
  try { fs.unlinkSync(keyFile()); } catch (_) {}
}

// Claude Code remembers a 401 at connect in <config dir>/mcp-needs-auth-cache.json as
// { "plugin:<plugin>:<server>": { timestamp } } and, for a server with headers or a
// headersHelper, skips connecting to it at all for 15 minutes (verified on 2.1.293). A
// session started right after sign-in would therefore never ask the helper for the new
// key. Dropping our own entry once the key is cached makes a restart pick it up. The
// file is undocumented: re-read right before an atomic rewrite, every other entry kept,
// any failure ignored. Returns true when an entry was removed.
function needsAuthFile() {
  const dir = (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
  return path.join(dir, 'mcp-needs-auth-cache.json');
}

function clearNeedsAuth(serverKey) {
  const file = needsAuthFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!entries || typeof entries !== 'object' || !Object.prototype.hasOwnProperty.call(entries, serverKey)) return false;
    delete entries[serverKey];
    fs.writeFileSync(tmp, JSON.stringify(entries), { encoding: 'utf8', mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

module.exports = { read, write, clear, keyFile, cacheDir, clearNeedsAuth, needsAuthFile };
