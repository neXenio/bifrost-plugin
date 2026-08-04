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

// Hook processes are separate OS processes and do NOT inherit Claude Code's MCP
// credential. Installing with `claude mcp add` (which is what bin/install.js and
// auto-setup.cjs do) writes the gateway URL and virtual key into ~/.claude.json as
// MCP server config, never into the environment — so every env-only lookup here
// came back empty and the whole hook layer went silently inert. Fall back to that
// config when the environment does not carry the credential.
//
// We match on the x-bf-vk header rather than on the server key, because the server
// may be registered under any name (user scope, plugin scope, `bifrost`, `bifrost-mcp`).
// Values still holding an unexpanded ${VAR} placeholder are ignored — the plugin's
// bundled .mcp.json ships exactly those, and they are not credentials.
const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const UNEXPANDED_RE = /\$\{[^}]*\}/;

// Memoized for the life of the process. ~/.claude.json also stores conversation
// history, so it is routinely half a megabyte and can be several. session-start calls
// env() three times, and re-parsing per call measurably slowed the startup path —
// which is the property this hook is built around. Hook processes are short-lived, so
// a process-lifetime cache cannot go stale in any way that matters.
let mcpCredentialCache;

function credentialFromMcpConfig() {
  if (mcpCredentialCache !== undefined) return mcpCredentialCache;
  mcpCredentialCache = readCredentialFromMcpConfig();
  return mcpCredentialCache;
}

function readCredentialFromMcpConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8')); } catch (_) { return null; }

  const usable = (s) => {
    if (!s || typeof s !== 'object') return null;
    const vk = s.headers && typeof s.headers === 'object' ? s.headers['x-bf-vk'] : null;
    const url = s.url;
    if (typeof vk !== 'string' || typeof url !== 'string') return null;
    if (!vk.trim() || !url.trim()) return null;
    if (UNEXPANDED_RE.test(vk) || UNEXPANDED_RE.test(url)) return null;
    return { url: url.trim(), vk: vk.trim() };
  };

  // Prefer the canonical server name over object insertion order. A developer with a
  // personal or staging gateway also registered would otherwise get whichever entry
  // happened to be added first, and that ordering flips on any `claude mcp add`.
  const fromMap = (servers) => {
    if (!servers || typeof servers !== 'object') return null;
    const canonical = usable(servers.bifrost);
    if (canonical) return canonical;
    for (const s of Object.values(servers)) {
      const hit = usable(s);
      if (hit) return hit;
    }
    return null;
  };

  // Order matters: THIS project's own server, then user scope, then anything else.
  // Iterating `Object.values(cfg.projects)` first would hand the current session an
  // unrelated project's key in insertion order, and virtual keys carry role scope, so
  // the agent would silently run under the wrong authorization.
  const here = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  const projects = cfg.projects || {};

  const mine = fromMap(projects[here] && projects[here].mcpServers);
  if (mine) return mine;

  const user = fromMap(cfg.mcpServers);
  if (user) return user;

  for (const [dir, proj] of Object.entries(projects)) {
    if (dir === here) continue;
    const hit = fromMap(proj && proj.mcpServers);
    if (hit) return hit;
  }
  return null;
}

// A gateway URL and the key that authenticates to it are ONE credential. Resolving
// them independently would let a stale `export BIFROST_URL=…` in a shell profile pair
// with the key from ~/.claude.json and send that key to a host it was never issued
// for — and this plugin already knows some users still export retired public tunnel
// hostnames (see LEGACY_GATEWAY_ENDPOINTS), which are re-registrable by anyone. So:
// take both from the environment, or both from the MCP config, never one of each.
// A lone BIFROST_URL is ignored rather than combined.
// Deliberately NOT filtered here: the endpoints in session-start's
// LEGACY_GATEWAY_ENDPOINTS are documented as retired, but at least one still answers
// with a valid MCP handshake and is somebody's configured gateway today. Refusing it
// on this path would silently re-break their plugin. The migration notice advises;
// it does not confiscate a working credential.
function env() {
  const url = (process.env.BIFROST_URL || '').trim();
  const vk = (process.env.BIFROST_VK || '').trim();
  if (url && vk) return { url, vk };
  // Claude exports every userConfig option to hook processes as
  // CLAUDE_PLUGIN_OPTION_<KEY>. Since 1.5.0 the bundled .mcp.json takes both values
  // from userConfig rather than from the environment, so on a Claude Desktop install
  // — where there is no shell profile to export anything — this is the only source
  // that carries a credential at all. Paired under the same rule as the env vars
  // above: both together, or neither.
  const optUrl = (process.env.CLAUDE_PLUGIN_OPTION_GATEWAY_URL || '').trim();
  const optVk = (process.env.CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY || '').trim();
  if (optUrl && optVk) return { url: optUrl, vk: optVk };
  const cfg = credentialFromMcpConfig();
  if (cfg) return cfg;
  return { url: '', vk: '' };
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
    // BIFROST_ALLOW_HTTP=1 is a legacy escape hatch for pre-1.2.0 deployments
    // whose gateway lives on a private network behind plain http — set it
    // deliberately, knowing the key crosses the wire unencrypted.
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    const allowHttp = isLoopback || process.env.BIFROST_ALLOW_HTTP === '1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) return resolve(null);
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

  // Flat names are `<server>-<tool>`, and BOTH halves may contain hyphens: servers
  // like `team-memory`, and tools like `skill-search` (which the fallback patterns
  // below deliberately accept). Neither the first hyphen nor the last is a reliable
  // boundary, so do not guess one — locate the substring the pattern actually matched
  // and treat everything before it as the server. Splitting on the first hyphen broke
  // `team-memory-memory_search`; splitting on the last breaks `skills-skill-search`.
  // Sorted, so a gateway exposing two skills or two memory servers resolves to the
  // same one on every refresh. Unsorted it followed tools/list order, which the
  // gateway does not promise to keep stable — the capability could silently switch
  // servers between refreshes and nothing would report it.
  const ordered = flatNames.slice().sort();

  const find = (re) => {
    for (const name of ordered) {
      const m = re.exec(name);
      if (!m) continue;
      const token = m[0].replace(/^[-_]/, '');       // patterns may capture a leading separator
      const at = name.lastIndexOf(token);
      const server = at > 0 ? name.slice(0, at).replace(/[-_]+$/, '') : '';
      return { server, mode: 'flat', tool: name };
    }
    return null;
  };

  let skills = find(/skill_search$/i) || find(/skill[_-]?search/i);
  let memory = find(/memory_search$/i) || find(/(^|[-_])memory[_-]?search/i);

  // Walk the code-mode catalog whenever the gateway offers one — NOT only when a
  // capability is missing. The old guard `(!skills || !memory)` meant that on a
  // gateway where both happen to be flat (the common case) the catalog was never
  // fetched at all, so the entire code-mode surface stayed invisible: on a real
  // deployment that measured 251 tools across 13 servers that no agent could see.
  // The roster is VK-scoped — the gateway already omits tools this key may not
  // call — so surfacing it discloses nothing the caller could not already reach.
  const roster = {};
  if (flatNames.includes('listToolFiles')) {
    const cat = parseBody((await rpc('tools/call', { name: 'listToolFiles', arguments: {} }, timeoutMs) || {}).body);
    const text = cat && cat.result && cat.result.content
      ? cat.result.content.map((c) => c.text || '').join('')
      : '';
    // Lines look like:  "  <server>/" then "    <tool>.pyi"
    let current = null;
    const codeServers = {}; // server -> Set(tool)
    for (const line of text.split(/\r?\n/)) {
      // Any line that looks like a server header ends the previous server, even if its
      // name fails the charset. Leaving `current` in place would silently donate the
      // rejected server's tools to whichever server preceded it, inflating that count.
      if (/\/\s*$/.test(line)) {
        const sm = line.match(/^\s{2}([A-Za-z0-9_-]+)\/\s*$/);
        current = sm ? sm[1] : null;
        if (current) codeServers[current] = codeServers[current] || [];
        continue;
      }
      const tm = line.match(/^\s{3,}([A-Za-z0-9_]+)\.pyi\s*$/);
      if (tm && current) codeServers[current].push(tm[1]);
    }
    const findCode = (re) => {
      for (const srv of Object.keys(codeServers).sort()) {
        const tool = codeServers[srv].find((t) => re.test(t));
        if (tool) return { server: srv, mode: 'code', tool };
      }
      return null;
    };
    if (!skills) skills = findCode(/skill_search/i);
    if (!memory) memory = findCode(/memory_search/i);

    // Keep the whole catalog, not just the two capabilities we came for. This is
    // what session-start turns into the visible tool roster.
    for (const [srv, tools] of Object.entries(codeServers)) {
      if (tools.length) roster[srv] = tools;
    }
  }

  return { at: Date.now(), skills, memory, roster };
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

// Resolve the flat tool name to call. Exported so the hooks print exactly what they
// would call, instead of composing the string a second time in a different place.
function flatToolName(cap, toolFn) {
  if (!cap) return toolFn;
  // Compare with separators normalized: a gateway may advertise the same function as
  // `skill-search` while callers name it `skill_search`. Without this the discovered
  // tool is not recognized as itself and gets rebuilt into a name that does not exist.
  const norm = (s) => String(s).replace(/[-_]/g, '_');
  if (cap.tool && new RegExp(`(^|_)${norm(toolFn)}$`).test(norm(cap.tool))) return cap.tool;
  return cap.server ? `${cap.server}-${toolFn}` : toolFn;
}

// Call a discovered capability (flat or code-mode). Returns parsed text or null.
async function callCapability(cap, toolFn, args, timeoutMs) {
  if (!cap) return null;
  let resp;
  if (cap.mode === 'flat') {
    // For the tool we actually discovered, use the name the gateway advertised
    // verbatim — it is known-good, whereas anything we reassemble is a guess. Only
    // siblings (skill_navigate, get_skill, memory_store, …) are built from the server
    // prefix, and a gateway exposing a bare tool with no prefix is called directly.
    const name = flatToolName(cap, toolFn);
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

// Two URLs name the same endpoint when they differ only in ways an HTTP client would
// ignore anyway. The normalization is deliberately narrow, and this is the whole of it:
//
//   - scheme and host are case-insensitive, and a default port is not a difference.
//     `new URL` already folds both, so this falls out of parsing rather than being
//     hand-rolled.
//   - one or more trailing slashes on the path are not a difference: `…/mcp` and
//     `…/mcp/` are one endpoint.
//   - a fragment is not sent to the server, so it is dropped.
//
// Everything else — the path itself, the query string, embedded userinfo — is compared
// verbatim. A gateway may legitimately encode a route or a credential there, so folding
// those away would suppress a genuine collision. A string that will not parse as a URL
// is compared trimmed and literally; it is never declared equal to something it does
// not match, because "unparseable" is not evidence of sameness.
// Substitute ${VAR} from the environment. An unset variable collapses to empty rather
// than staying literal, so a caller can tell "did not expand" from "expanded to nothing"
// by testing the raw string against UNEXPANDED_RE.
function expandVars(raw) {
  return String(raw == null ? '' : raw).trim()
    .replace(/\$\{([^}]*)\}/g, (_, v) => process.env[v] || '')
    .trim();
}

function sameEndpoint(a, b) {
  const norm = (raw) => {
    const s = String(raw == null ? '' : raw).trim();
    try {
      const u = new URL(s);
      u.hash = '';
      return u.href.replace(/\/+$/, '');
    } catch (_) {
      return s.replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

// Detect an MCP server-name collision between a project's .mcp.json and the user's
// own registration.
//
// Claude Code keys MCP servers by name per scope, and the user-scope entry wins. Two
// distinct failures come out of that, and both are silent:
//
//   1. The project ships `.mcp.json` declaring `bifrost` with `${BIFROST_URL}`, the
//      variable is unset, and the user has separately run `claude mcp add … bifrost`.
//      The project entry cannot expand and `mcp__bifrost__*` stops being exposed —
//      the tools are simply absent, which reads as "the gateway is down".
//   2. Both entries resolve, but to DIFFERENT endpoints. Nothing disappears, so
//      nothing looks wrong at all; the session just talks to the user-scope gateway
//      while the project believes it is talking to its own. This is the worse of the
//      two, because the only symptom is answers sourced from the wrong corpus.
//
// If both sides resolve to the same endpoint there is nothing to report.
//
// Returns { name, reason: 'unresolved' | 'divergent', projectUrl, userUrl } for the
// first colliding server, or null.
function detectServerNameCollision() {
  const dir = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  if (!dir) return null;

  let project;
  try { project = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')); } catch (_) { return null; }
  const projectServers = (project && project.mcpServers) || {};

  let user;
  try { user = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8')); } catch (_) { return null; }
  const userServers = (user && user.mcpServers) || {};

  for (const [name, entry] of Object.entries(projectServers)) {
    const mine = userServers[name];
    if (!mine || typeof mine.url !== 'string') continue;

    // An entry with no url of its own (a stdio `command` server, say) gives nothing to
    // compare against, so there is no claim to make about it either way.
    const raw = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!raw) continue;

    // Both sides have to be expanded before they are comparable. `claude mcp add` writes
    // a literal, but a user-scope entry may equally hold `${BIFROST_URL}` — that is the
    // shape you get after deliberately collapsing the key to a single source, and it is
    // the SAME endpoint as the project entry, not a divergent one. Expanding only the
    // project side compared a resolved url against the raw string "${BIFROST_URL}" and
    // reported a divergence on every session.
    const rawUser = mine.url.trim();
    const expanded = expandVars(raw);
    const expandedUser = expandVars(rawUser);

    // Either side failing to expand is the vanishing-tools case: the project entry has
    // no endpoint, or the user entry that wins the name has none.
    if ((UNEXPANDED_RE.test(raw) && !expanded) || (UNEXPANDED_RE.test(rawUser) && !expandedUser)) {
      return { name, reason: 'unresolved', projectUrl: expanded, userUrl: expandedUser || rawUser };
    }
    if (sameEndpoint(expanded, expandedUser)) continue;
    return { name, reason: 'divergent', projectUrl: expanded, userUrl: expandedUser };
  }
  return null;
}

// Synchronous, network-free read of the discovery cache. SessionStart needs the
// roster while staying fully synchronous (it exits the process immediately, so a
// promise would never settle).
// `maxAgeMs` is the caller's EMIT tolerance — how old content may be and still be
// worth showing. That is a different question from DISCOVERY_TTL_MS, which decides
// when to re-fetch over the network. Conflating them made the roster disappear from
// any session starting more than an hour after the last refresh, while skills and
// memory (24h tolerance) stayed: the roster silently went missing far more often than
// it appeared. Callers pass the tolerance that matches what they are emitting; an
// unbounded read is not offered, because that is what let a permanently dead gateway
// inject a roster of arbitrary age.
function readDiscoveryCacheSync(maxAgeMs, now = Date.now()) {
  const c = readCache();
  if (!c || !Number.isFinite(maxAgeMs) || now - c.at >= maxAgeMs) return null;
  return c;
}

module.exports = {
  env,
  getCapabilities,
  callCapability,
  readDiscoveryCacheSync,
  credentialFromMcpConfig,
  detectServerNameCollision,
  sameEndpoint,
  flatToolName,
  discover,
  DISCOVERY_CACHE,
};
