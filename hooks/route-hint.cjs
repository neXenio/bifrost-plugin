'use strict';
// PreToolUse hook — point the model at the gateway when it reaches for a service the
// gateway already serves. `curl https://gitlab.com/api/...`, `glab`, a WebFetch of a
// Jira page: each works around a code-mode server that holds the company credentials
// and is logged and access-controlled. The hint names the server and how to call it.
//
// Hint only: never denies, never rewrites, no network (reads the discovery cache), and
// fires once per server per session. Only servers present in this key's roster are
// named, so the hint never offers something the key cannot call. Server knob: keyapp
// hook `route-hint`, field `enabled` (env BIFROST_ROUTE_HINT). Always exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const gw = require('./lib/gateway.cjs');
const pc = require('./lib/plugin-config.cjs');

// server -> what identifies a direct call to it in a Bash command or a fetched URL.
const ROUTES = [
  ['gitlab', /\bgitlab\.com\b|^\s*glab\s/],
  ['jira', /\batlassian\.net\b|^\s*(acli|jira)\s/],
  ['grafana', /\bgrafana\.(net|com)\b|\bgrafana\.[a-z0-9.-]+\/api\//],
  ['hubspot', /\b(api\.hubapi\.com|app\.hubspot\.com|api\.hubspot\.com)\b/],
  ['sentry', /\bsentry\.io\b/],
  ['glitchtip', /\bglitchtip\b/],
  ['metabase', /\bmetabase\b/],
  ['mattermost', /\bmattermost\b.*\/api\/v4\//],
  ['webflow', /\bapi\.webflow\.com\b/],
  ['clarity', /\bclarity\.ms\b/],
];

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// The text this call would reach out with. Plain git (clone, push, fetch) talks to
// GitLab too, but that is not something an MCP tool replaces.
function target(event) {
  const input = event.tool_input || {};
  if (event.tool_name === 'WebFetch') return String(input.url || '');
  if (event.tool_name === 'Bash') {
    const cmd = String(input.command || '');
    return /^\s*git\s/.test(cmd) ? '' : cmd;
  }
  return '';
}

function matchServer(text, roster) {
  if (!text || !roster) return null;
  for (const [server, re] of ROUTES) {
    if (Array.isArray(roster[server]) && roster[server].length && re.test(text)) return server;
  }
  return null;
}

function hint(server, tools) {
  const sample = tools.slice(0, 4).join(', ');
  return [
    `Bifrost has a \`${server}\` server (${tools.length} tools, e.g. ${sample}) that already holds`,
    'the company credentials. Prefer it over calling the service directly: read',
    `\`readToolFile(fileName="servers/${server}.pyi")\`, then`,
    `\`executeToolCode\` with \`result = ${server}.<tool>(...)\`. Fall back to the direct call`,
    'only if the gateway lacks what you need.',
  ].join(' ');
}

// One marker per server per session, next to the other per-session markers.
function firstTime(sessionId, server) {
  if (!sessionId) return true;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const file = path.join(os.homedir(), '.cache', 'bifrost-plugin', 'reflect', `${safe}.route-${server}`);
  try {
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
  } catch (_) { /* best-effort */ }
  return true;
}

async function main() {
  let event = {};
  try { event = JSON.parse(await readStdin()); } catch (_) {}
  try {
    if (!gw.env().vk) return;
    let cfg = null;
    try { cfg = pc.loadCached(); } catch (_) {}
    if (!pc.hookFlag(cfg, 'route-hint', 'enabled', 'BIFROST_ROUTE_HINT', true)) return;
    const disc = gw.readDiscoveryCacheSync(7 * 24 * 60 * 60 * 1000);
    const server = matchServer(target(event), disc && disc.roster);
    if (!server || !firstTime(event.session_id, server)) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hint(server, disc.roster[server]) },
    }));
  } catch (_) { /* silent-fail */ }
}

if (require.main === module) main().finally(() => process.exit(0));

module.exports = { target, matchServer, hint, ROUTES };
