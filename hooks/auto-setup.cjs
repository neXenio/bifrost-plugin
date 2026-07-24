'use strict';
// Auto-provision worker. Run EXPLICITLY by the user via the /bifrost-setup
// command — it is never spawned automatically (no hook launches browsers or
// writes config on the user's behalf). Fully best-effort:
//   1. Start a loopback listener on 127.0.0.1:<ephemeral> with a single-use nonce.
//   2. Open the SSO keyapp at KEYAPP_BASE?cb=http://127.0.0.1:<port>/cb?state=<nonce>.
//      If the user already holds a valid SSO cookie the page resolves their key and
//      303-redirects straight back to the loopback — no interaction at all.
//   3. On callback, validate the nonce, then persist the MCP server with the key via
//      `claude mcp add --scope user` (no fallback: if the CLI is unreachable we
//      report failure rather than guessing at config paths).
//   4. Write a result marker so the SessionStart hook can surface a one-line warning
//      next session if this failed. Never throws; always exits 0.
//
// Guardrails: listener is loopback-only + nonce-gated + single-use + times out (90s),
// so nothing else on the machine can drive it or exfiltrate the key.
//
// No default keyapp/gateway URL is assumed — this worker is a no-op unless the
// gateway operator has explicitly configured BIFROST_KEYAPP_URL (the SSO
// callback page for THIS deployment) and BIFROST_URL. Without them there is no
// generic keyapp to open, so we skip silently rather than guessing an endpoint.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const KEYAPP_BASE = (process.env.BIFROST_KEYAPP_URL || '').replace(/\/+$/, '');
const MCP_ENDPOINT = (process.env.BIFROST_URL || '').trim();
const TIMEOUT_MS = parseInt(process.env.BIFROST_SETUP_TIMEOUT_MS || '90000', 10);

const STATE_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const RESULT_MARKER = path.join(STATE_DIR, 'auto-setup-result.json');

function writeResult(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RESULT_MARKER, JSON.stringify({ at: Date.now(), ...obj }), 'utf8');
  } catch (e) {
    process.stderr.write(`bifrost-plugin: failed to write auto-setup result marker: ${e && e.message}\n`);
  }
}

// Open a URL in the default browser, per-platform. Best-effort, never throws.
function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}

// Persist the MCP server authoritatively via `claude mcp add` (writes to CC's own
// user-scope config, wherever that lives). If the CLI isn't reachable we don't guess
// an alternate config path — we report failure so the hook warns and the user runs
// /bifrost-setup. Resolves the write method string, or null on failure.
function persistKey(vk) {
  return new Promise((resolve) => {
    const args = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'bifrost',
      MCP_ENDPOINT, '--header', `x-bf-vk: ${vk}`];
    execFile('claude', args, { timeout: 15000 }, (err) => resolve(err ? null : 'claude-cli'));
  });
}

function main() {
  if (!KEYAPP_BASE || !MCP_ENDPOINT) {
    writeResult({ ok: false, reason: 'not-configured' });
    return process.exit(0);
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  let done = false;

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/cb') { res.writeHead(404); return res.end(); }
      if (u.searchParams.get('state') !== nonce) { res.writeHead(403); return res.end('bad state'); }
      const vk = (u.searchParams.get('vk') || '').trim();
      if (!vk) { res.writeHead(400); return res.end('no key'); }
      if (done) { res.writeHead(200); return res.end(); }
      done = true;
      const how = await persistKey(vk);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Bifrost</title>' +
        '<body style="font:15px -apple-system,sans-serif;max-width:420px;margin:14vh auto;text-align:center">' +
        (how ? '<h2>✓ Bifrost connected</h2><p>You can close this tab and restart Claude Code.</p>'
             : '<h2>Key received</h2><p>Could not write config automatically — run <code>/bifrost-setup</code>.</p>') +
        '</body>');
      writeResult(how ? { ok: true, how } : { ok: false, reason: 'persist-failed' });
      cleanup();
    } catch (e) {
      writeResult({ ok: false, reason: 'callback-error' });
      cleanup();
    }
  });

  function cleanup() {
    try { server.close(); } catch (_) {}
    clearTimeout(timer);
    process.exit(0);
  }

  const timer = setTimeout(() => {
    if (!done) writeResult({ ok: false, reason: 'timeout' });
    cleanup();
  }, TIMEOUT_MS);

  server.on('error', () => { writeResult({ ok: false, reason: 'listen-error' }); cleanup(); });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const cb = `http://127.0.0.1:${port}/cb?state=${nonce}`;
    openBrowser(`${KEYAPP_BASE}/?cb=${encodeURIComponent(cb)}`);
  });
}

try { main(); } catch (_) { writeResult({ ok: false, reason: 'fatal' }); process.exit(0); }
