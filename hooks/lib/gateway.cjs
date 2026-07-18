'use strict';
// Minimal Bifrost gateway client + capability discovery for the plugin hooks.
//
// The gateway is an MCP server reachable over Streamable HTTP at $BIFROST_URL,
// authenticated with the x-bf-vk header ($BIFROST_VK). Some upstream servers are
// exposed as flat tools (mcp__bifrost__<server>-<tool>); others are reachable
// only through the code-mode meta-tool executeToolCode, which runs Starlark like
// `result = <server>.<tool>(param=value)`. This lib hides that split: it
// discovers which servers expose skill-search and memory-search, and how to call
// them, caching the result so the per-prompt hook never hits the network.
//
// Everything here is best-effort and side-effect-free on failure: callers get
// null/empty and must degrade silently. Never throws to the hook.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const DISCOVERY_CACHE = path.join(CACHE_DIR, 'discovery.json');
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — server topology rarely changes

function env() {
  return {
    url: (process.env.BIFROST_URL || '').trim(),
    vk: (process.env.BIFROST_VK || '').trim(),
  };
}

// One JSON-RPC round-trip over Streamable HTTP. Resolves {status, body} or null.
function rpc(method, params, timeoutMs) {
  const { url, vk } = env();
  if (!url || !vk) return Promise.resolve(null);
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    // Never send the x-bf-vk key in cleartext: plain http is only allowed to
    // loopback (local dev gateways). Anything else must be https.
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) return resolve(null);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'x-bf-vk': vk,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (resp) => {
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs || 3000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// Responses may be a single JSON object or an SSE stream of `data:` lines.
function parseBody(body) {
  if (!body) return null;
  const dataLines = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  const raw = dataLines.length ? dataLines.join('') : body;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function handshake(timeoutMs) {
  const r = await rpc(
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bifrost-plugin-hook', version: '0' } },
    timeoutMs
  );
  return !!(r && r.status === 200);
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(DISCOVERY_CACHE, 'utf8'));
    if (c && typeof c.at === 'number') return c;
  } catch (_) {}
  return null;
}

function writeCache(disc) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(DISCOVERY_CACHE, JSON.stringify(disc), 'utf8');
  } catch (_) {}
}

// Inspect the gateway and decide how to reach skill-search and memory-search.
// Returns { skills, memory } where each is null or { server, mode: 'flat'|'code' }.
async function discover(timeoutMs) {
  if (!(await handshake(timeoutMs))) return null;

  const flat = parseBody((await rpc('tools/list', {}, timeoutMs) || {}).body);
  const flatTools = (flat && flat.result && flat.result.tools) || [];
  const flatNames = flatTools.map((t) => t.name);

  const find = (re) => {
    // Flat tool wins: callable directly as mcp__bifrost__<name>.
    const flatHit = flatNames.find((n) => re.test(n));
    if (flatHit) {
      const server = flatHit.includes('-') ? flatHit.slice(0, flatHit.indexOf('-')) : flatHit;
      return { server, mode: 'flat', tool: flatHit };
    }
    return null;
  };

  let skills = find(/skill_search$/i) || find(/skill[_-]?search/i);
  let memory = find(/memory_search$/i) || find(/(^|[-_])memory[_-]?search/i);

  // Anything not flat may live behind the code-mode catalog (listToolFiles).
  if ((!skills || !memory) && flatNames.includes('listToolFiles')) {
    const cat = parseBody((await rpc('tools/call', { name: 'listToolFiles', arguments: {} }, timeoutMs) || {}).body);
    const text = cat && cat.result && cat.result.content
      ? cat.result.content.map((c) => c.text || '').join('')
      : '';
    // Lines look like:  "  <server>/" then "    <tool>.pyi"
    let current = null;
    const codeServers = {}; // server -> Set(tool)
    for (const line of text.split(/\r?\n/)) {
      const sm = line.match(/^\s{2}([A-Za-z0-9_-]+)\/\s*$/);
      if (sm) { current = sm[1]; codeServers[current] = codeServers[current] || []; continue; }
      const tm = line.match(/^\s{3,}([A-Za-z0-9_]+)\.pyi\s*$/);
      if (tm && current) codeServers[current].push(tm[1]);
    }
    const findCode = (re) => {
      for (const srv of Object.keys(codeServers)) {
        const tool = codeServers[srv].find((t) => re.test(t));
        if (tool) return { server: srv, mode: 'code', tool };
      }
      return null;
    };
    if (!skills) skills = findCode(/skill_search/i);
    if (!memory) memory = findCode(/memory_search/i);
  }

  return { at: Date.now(), skills, memory };
}

// Cached discovery; refreshes if missing/stale. Returns discovery or null.
async function getCapabilities(timeoutMs, { refresh = false, cacheOnly = false } = {}) {
  if (!refresh) {
    const c = readCache();
    if (c && Date.now() - c.at < DISCOVERY_TTL_MS) return c;
  }
  if (cacheOnly) return readCache(); // never hit the network (per-prompt hook)
  const disc = await discover(timeoutMs);
  if (disc) writeCache(disc);
  return disc || readCache(); // fall back to stale cache if the refresh failed
}

// Call a discovered capability (flat or code-mode). Returns parsed text or null.
async function callCapability(cap, toolFn, args, timeoutMs) {
  if (!cap) return null;
  let resp;
  if (cap.mode === 'flat') {
    // Flat tools are <server>-<tool>; derive the sibling tool from toolFn so the
    // same cap can call skill_search, skill_navigate, get_skill, etc.
    const name = `${cap.server}-${toolFn}`;
    resp = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  } else {
    const kv = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    const code = `result = ${cap.server}.${toolFn}(${kv})`;
    resp = await rpc('tools/call', { name: 'executeToolCode', arguments: { code } }, timeoutMs);
  }
  const parsed = parseBody((resp || {}).body);
  if (!parsed || !parsed.result || !parsed.result.content) return null;
  return parsed.result.content.map((c) => c.text || '').join('\n');
}

module.exports = { env, getCapabilities, callCapability, DISCOVERY_CACHE };
