'use strict';
// Browser sign-in worker. Two ways it runs, both best-effort:
//   - explicitly, by the user, from the /bifrost-setup command;
//   - automatically, spawned detached by session-start.cjs, but ONLY when the user
//     (or the operator's mirror of this plugin) turned on the opt-in `auto_login`
//     option and no key is configured anywhere. See session-start.cjs for the gates.
//
//   1. Start a loopback listener on 127.0.0.1:<ephemeral> with a single-use nonce.
//   2. Open the SSO keyapp at KEYAPP_BASE/?cb=http://127.0.0.1:<port>/cb?state=<nonce>.
//      If the user already holds a valid SSO cookie the page resolves their key and
//      303-redirects straight back to the loopback — no interaction at all.
//   3. On callback, validate the nonce, then cache the key for THIS gateway in
//      ~/.cache/bifrost-plugin/vk (hooks/lib/key-cache.cjs). The hooks read it via
//      gateway.cjs env(); the MCP connection reads it via the hooks/vk-headers.cjs
//      headersHelper. It used to run `claude mcp add` instead, which registered a
//      second `bifrost` server next to the plugin's own one.
//   4. Write a result marker (ok/reason only, never the key) so a failure can be
//      diagnosed. Never throws; always exits 0.
//
// Guardrails: listener is loopback-only + nonce-gated + single-use + times out (5 min),
// so nothing else on the machine can drive it or exfiltrate the key. The keyapp must
// be https (loopback excepted for local dev), since the page it serves hands out keys.
//
// Keyapp base: BIFROST_KEYAPP_URL, else the plugin's `keyapp_url` option, else — only
// when auto-login is enabled — the origin of the gateway URL (the shipped deployment
// serves the keyapp on the gateway's own host). Gateway: BIFROST_URL, else the
// plugin's `gateway_url` option or its manifest default. Without both, this is a no-op
// rather than a guess.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const keyCache = require('./lib/key-cache.cjs');
const { pluginOption, pluginName } = require('./lib/gateway.cjs');

// A first sign-in (password, 2FA, consent) easily outlasts 90 s, so 5 min.
const TIMEOUT_MS = parseInt(process.env.BIFROST_SETUP_TIMEOUT_MS || '300000', 10);
// After a timeout (tab closed, login abandoned) the next startup may retry sooner than
// the normal 6 h cooldown in session-start.cjs.
const TIMEOUT_COOLDOWN_MS = 30 * 60 * 1000;

const STATE_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const RESULT_MARKER = path.join(STATE_DIR, 'auto-setup-result.json');
// Shared with session-start.cjs: the cooldown marker is cleared on success so a later
// key loss can retry straight away, and the in-flight lock is released on every exit.
const ATTEMPT_MARKER = path.join(STATE_DIR, 'auto-login-attempt.json');
const LOCK_FILE = path.join(STATE_DIR, 'auto-login.lock');

function autoLoginEnabled() {
  const on = (v) => /^(1|true|yes)$/i.test(String(v || '').trim());
  return on(process.env.BIFROST_AUTO_LOGIN) || on(pluginOption('auto_login'));
}

// Options go through pluginOption: hooks only see values the user saved, so the
// manifest defaults (the shipped gateway_url in particular) are read from plugin.json.
// The key is cached for the URL the plugin's MCP server uses. BIFROST_URL counts only
// together with BIFROST_VK, the pairing rule gateway.cjs env() applies: a lone, stale
// export must never decide where a fresh key may be sent.
function gatewayUrl(env = process.env) {
  const url = (env.BIFROST_URL || '').trim();
  if (url && (env.BIFROST_VK || '').trim()) return url;
  return pluginOption('gateway_url', env).trim();
}

function keyappBase(gateway) {
  const explicit = (process.env.BIFROST_KEYAPP_URL || pluginOption('keyapp_url')).trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (!autoLoginEnabled()) return '';
  try { return new URL(gateway).origin; } catch (_) { return ''; }
}

function isSafeKeyapp(base) {
  try {
    const u = new URL(base);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
  } catch (_) {
    return false;
  }
}

function writeResult(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RESULT_MARKER, JSON.stringify({ at: Date.now(), ...obj }), 'utf8');
  } catch (e) {
    process.stderr.write(`bifrost-plugin: failed to write auto-setup result marker: ${e && e.message}\n`);
  }
}

// Open a URL in the browser, per-platform. Best-effort, never throws. On macOS prefer
// Chrome, where company SSO sessions usually live; `open -a` exits non-zero when it is
// not installed, so fall back to the default browser.
function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      const chrome = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
      chrome.on('error', () => openDefault(url));
      chrome.on('exit', (code) => { if (code !== 0) openDefault(url); });
      return;
    }
    openDefault(url);
  } catch (_) {}
}

function openDefault(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}

function main() {
  const gateway = gatewayUrl();
  const base = keyappBase(gateway);
  if (!base || !gateway) {
    writeResult({ ok: false, reason: 'not-configured' });
    return finish();
  }
  if (!isSafeKeyapp(base)) {
    writeResult({ ok: false, reason: 'insecure-keyapp' });
    return finish();
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  let done = false;

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/cb') { res.writeHead(404); return res.end(); }
      if (u.searchParams.get('state') !== nonce) { res.writeHead(403); return res.end('bad state'); }
      const vk = (u.searchParams.get('vk') || '').trim();
      if (!vk) { res.writeHead(400); return res.end('no key'); }
      if (done) { res.writeHead(200); return res.end(); }
      done = true;
      const ok = keyCache.write(gateway, vk);
      if (ok) {
        try { fs.unlinkSync(ATTEMPT_MARKER); } catch (_) {}
        keyCache.clearNeedsAuth(`plugin:${pluginName()}:bifrost`);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Bifrost</title>' +
        '<body style="font:15px -apple-system,sans-serif;max-width:420px;margin:14vh auto;text-align:center">' +
        (ok ? '<h2>✓ Bifrost connected</h2><p>You can close this tab. Restart Claude Code, or in ' +
              'a running session run <code>/mcp</code>, pick <b>bifrost</b> and choose ' +
              '<b>Reconnect</b> (not Authenticate).</p>'
            : '<h2>Key received</h2><p>Could not save it on this machine. Run <code>/bifrost-setup</code>.</p>') +
        '</body>');
      writeResult(ok ? { ok: true, how: 'key-cache' } : { ok: false, reason: 'persist-failed' });
      cleanup();
    } catch (e) {
      writeResult({ ok: false, reason: 'callback-error' });
      cleanup();
    }
  });

  function cleanup() {
    try { server.close(); } catch (_) {}
    clearTimeout(timer);
    finish();
  }

  const timer = setTimeout(() => {
    if (!done) {
      writeResult({ ok: false, reason: 'timeout' });
      // Only an automatic attempt has a cooldown marker to shorten.
      if (fs.existsSync(ATTEMPT_MARKER)) {
        try { fs.writeFileSync(ATTEMPT_MARKER, JSON.stringify({ at: Date.now(), cooldownMs: TIMEOUT_COOLDOWN_MS }), 'utf8'); } catch (_) {}
      }
    }
    cleanup();
  }, TIMEOUT_MS);

  server.on('error', () => { writeResult({ ok: false, reason: 'listen-error' }); cleanup(); });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const cb = `http://127.0.0.1:${port}/cb?state=${nonce}`;
    openBrowser(`${base}/?cb=${encodeURIComponent(cb)}`);
  });
}

// Release the in-flight lock session-start.cjs took before spawning us, and only that
// one: it passes the lock's token, so a /bifrost-setup run (no token) or a worker whose
// lock was taken over never deletes a lock another session holds.
function finish() {
  const token = process.env.BIFROST_AUTO_LOGIN_LOCK_TOKEN;
  try {
    if (token && JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).token === token) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
  process.exit(0);
}

if (require.main === module) {
  try { main(); } catch (_) { writeResult({ ok: false, reason: 'fatal' }); finish(); }
}

// session-start.cjs runs the same checks before it announces a sign-in.
module.exports = { gatewayUrl, keyappBase, isSafeKeyapp };
