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
const keyCache = require('./key-cache.cjs');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const { scopeKey, scopedDirectory } = require('./cache-scope.cjs');
function discoveryCacheFile(credential = env()) {
  const dir = scopedDirectory(credential.url, credential.vk);
  return dir ? path.join(dir, 'discovery.json') : null;
}
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — server topology rarely changes

// Hook processes are separate OS processes and do NOT inherit Claude Code's MCP
// credential. Installing with `claude mcp add` (which is what scripts/install.js and
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

// Server and tool names arrive from the gateway's tools/list and get interpolated
// into text that reaches the model in the plugin's own authoritative voice — session
// start renders them several times, and prompt-submit repeats them on every
// task-shaped prompt. That makes them exactly as untrusted as memory content, so they
// get the same treatment: an MCP name is an identifier, and anything that is not one
// is refused rather than cleaned up. Length is bounded as well as charset, because an
// underscore_separated_name of unbounded length reads as a sentence once rendered.
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isIdentifier(s) {
  return typeof s === 'string' && IDENTIFIER_RE.test(s);
}

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

let claudeConfigCache;

function claudeConfig() {
  if (claudeConfigCache === undefined) {
    try { claudeConfigCache = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8')); } catch (_) { claudeConfigCache = null; }
  }
  return claudeConfigCache;
}

function readCredentialFromMcpConfig() {
  const cfg = claudeConfig();
  if (!cfg) return null;

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

  // Only this project's server and the intended user scope may supply credentials.
  // Other project entries carry their own authorization and must never be borrowed.
  const here = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  const projects = cfg.projects || {};

  const mine = fromMap(projects[here] && projects[here].mcpServers);
  if (mine) return mine;

  const user = fromMap(cfg.mcpServers);
  if (user) return user;

  return null;
}

// A plugin option as hooks see it. Claude Code exports CLAUDE_PLUGIN_OPTION_<KEY> only
// for values the user actually saved: verified on 2.1.293, a userConfig `default`
// is substituted into .mcp.json's ${user_config.*} but never reaches the hook
// environment. So an org-pushed install where nobody opened the config dialog sees no
// gateway_url and no auto_login at all, and the manifest default has to be read here.
// An empty saved value counts as unset, matching how .mcp.json treats it.
const PLUGIN_MANIFEST = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
let manifestDefaults;

function pluginOption(key, envVars = process.env) {
  const v = envVars[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (manifestDefaults === undefined) {
    manifestDefaults = {};
    try {
      const uc = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, 'utf8')).userConfig || {};
      for (const [k, o] of Object.entries(uc)) {
        if (o && o.default !== undefined && o.default !== null) manifestDefaults[k] = String(o.default);
      }
    } catch (_) {}
  }
  return manifestDefaults[key] || '';
}

// The namespace the gateway's tools carry in this session: Claude Code names them
// mcp__<server>__<tool> with the server name sanitized ([^A-Za-z0-9_-] -> _, read from
// the 2.1.293 binary). A hand-added `bifrost` server (user scope, or this project's
// local scope) suppresses the plugin's own as a duplicate and is what env() reads its
// credential from, so it keeps the legacy name. Otherwise a plugin install exposes
// plugin:<name>:bifrost. The claude.ai org connector (mcp__claude_ai_<Name>__) cannot be
// detected from a hook; the guidance names it as the alternative.
function toolPrefix(envVars = process.env) {
  const cfg = claudeConfig() || {};
  const here = (envVars.CLAUDE_PROJECT_DIR || process.cwd() || '').trim();
  const local = cfg.projects && cfg.projects[here] && cfg.projects[here].mcpServers;
  const manual = (cfg.mcpServers && cfg.mcpServers.bifrost) || (local && local.bifrost);
  const name = pluginName();
  if (manual || !(envVars.CLAUDE_PLUGIN_ROOT || '').trim() || !name) return 'mcp__bifrost__';
  return `mcp__plugin_${name.replace(/[^A-Za-z0-9_-]/g, '_')}_bifrost__`;
}

// This plugin's own name from plugin.json — Claude Code keys the plugin's MCP server as
// `plugin:<name>:bifrost`, and a mirror may rename the plugin.
function pluginName() {
  try { return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, 'utf8')).name || ''; } catch (_) { return ''; }
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
  // above: both together, or neither. An unsaved gateway_url is the manifest default
  // (only saved options are exported), which is what .mcp.json pairs the key with too.
  const optVk = (process.env.CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY || '').trim();
  const optUrl = optVk ? pluginOption('gateway_url') : '';
  if (optUrl && optVk) return { url: optUrl, vk: optVk };
  const cfg = credentialFromMcpConfig();
  if (cfg) return cfg;
  // Last resort: the key the opt-in auto-login flow cached (see key-cache.cjs). Every
  // explicit source above wins over it. The cache records which gateway the key was
  // issued for, so the pairing rule still holds: when a gateway URL is known on its
  // own (a lone BIFROST_URL, or the plugin's gateway_url option or its manifest
  // default), the cached key is used only if it belongs to that same endpoint.
  const cached = keyCache.read();
  if (cached) {
    const known = url || pluginOption('gateway_url');
    if (!known || sameEndpoint(known, cached.url)) return { url: cached.url, vk: cached.vk };
  }
  return { url: '', vk: '' };
}

const PROTOCOL_VERSION = '2025-06-18';
// Hooks are short-lived best-effort clients, not bulk exporters. Bound each response
// (including discarded SSE progress) to 4 MiB so a gateway cannot grow their memory
// without limit. Oversized catalogs fail closed and retain the existing cache fallback.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
let transportSession;
let requestId = 0;

// Session state belongs to one endpoint/key pair and is never persisted to disk.
async function rpc(method, params, timeoutMs, credential = env()) {
  try {
    if (!credential.url || !credential.vk) return null;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
    const deadline = Date.now() + budget;
    let timer;
    const operation = async () => {
      if (method === 'initialize') return sendRpc(method, params, deadline, credential);
      const session = await ensureSession(deadline, credential);
      if (!session || Date.now() >= deadline) return null;
      const response = await sendRpc(method, params, deadline, credential, session);
      // Do not replay tools/call: it may have side effects. A later call can reconnect.
      if (response && (response.status === 404 || response.status === 401)) {
        if (transportSession === session) transportSession = undefined;
      }
      return response;
    };
    try {
      return await Promise.race([
        operation(),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), budget); }),
      ]);
    } finally { clearTimeout(timer); }
  } catch (_) { return null; }
}

async function ensureSession(deadline, credential) {
  let session = transportSession;
  if (!session || session.url !== credential.url || session.vk !== credential.vk) {
    session = { ...credential };
    transportSession = session;
    session.ready = (async () => {
      const response = await sendRpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'bifrost-plugin-hook', version: '0' },
      }, deadline, credential);
      const result = response && response.status === 200 && parseBody(response.body)?.result;
      if (!result || result.protocolVersion !== PROTOCOL_VERSION ||
          !result.capabilities || typeof result.capabilities !== 'object' || Array.isArray(result.capabilities) ||
          !result.serverInfo || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') return null;
      session.protocolVersion = result.protocolVersion;
      const id = response.headers['mcp-session-id'];
      if (id !== undefined && (typeof id !== 'string' || !/^[\x21-\x7E]+$/.test(id))) return null;
      session.id = id;
      const initialized = await sendRpc('notifications/initialized', undefined, deadline, credential, session, true);
      return initialized && initialized.status === 202 ? session : null;
    })().catch(() => null);
  }
  const ready = await session.ready;
  if (!ready && transportSession === session) transportSession = undefined;
  return ready;
}

// One JSON-RPC round-trip over Streamable HTTP. Resolves {status, body} or null.
function sendRpc(method, params, deadline, credential, session, notification = false) {
  const { url, vk } = credential;
  return new Promise((resolve) => {
    let req;
    let timer;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const u = new URL(url);
      // Never send the x-bf-vk key in cleartext: plain http is only allowed to
      // loopback (local dev gateways). Anything else must be https.
      // BIFROST_ALLOW_HTTP=1 is a legacy escape hatch for pre-1.2.0 deployments
      // whose gateway lives on a private network behind plain http — set it
      // deliberately, knowing the key crosses the wire unencrypted.
      const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
      const allowHttp = isLoopback || process.env.BIFROST_ALLOW_HTTP === '1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) return finish(null);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish(null);
      const id = notification ? undefined : ++requestId;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const lib = u.protocol === 'http:' ? http : https;
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-bf-vk': vk,
        'Content-Length': Buffer.byteLength(payload),
      };
      if (session) {
        headers['MCP-Protocol-Version'] = session.protocolVersion;
        if (session.id) headers['Mcp-Session-Id'] = session.id;
      }
      req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
      }, resp => {
        if (resp.statusCode === 401) forgetCachedKey(url, vk);
        let body = '';
        let bytes = 0;
        const readEvent = sseReader(id);
        const sse = /^text\/event-stream(?:;|$)/i.test(resp.headers['content-type'] || '');
        resp.setEncoding('utf8');
        resp.on('error', () => finish(null));
        resp.on('aborted', () => finish(null));
        resp.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_RESPONSE_BYTES) { finish(null); resp.destroy(); return; }
          if (sse && !notification && resp.statusCode === 200) {
            const parsed = readEvent(chunk);
            if (parsed) {
              const body = JSON.stringify(parsed);
              finish(parseBody(body, id) ? { status: resp.statusCode, body, headers: resp.headers } : null);
              resp.destroy();
            }
          } else { body += chunk; }
        });
        resp.on('end', () => {
          if (notification || resp.statusCode !== 200) {
            finish({ status: resp.statusCode, body: '', headers: resp.headers });
            return;
          }
          const parsed = sse ? null : parseBody(body, id);
          finish(parsed ? { status: resp.statusCode, body: JSON.stringify(parsed), headers: resp.headers } : null);
        });
      });
      req.on('error', () => finish(null));
      timer = setTimeout(() => { finish(null); req.destroy(); }, remaining);
      req.end(payload);
    } catch (_) {
      finish(null);
      if (req) req.destroy();
    }
  });
}

// A 401 with the key auto-login cached means that key is dead (rotated or revoked in
// the key page). Drop it, and the cooldown marker with it, so the next startup signs in
// again instead of sending the dead key forever. Only a 401 counts: a network error or
// a 5xx says nothing about the key. A key from any other source is the user's own
// configuration and is never touched.
function forgetCachedKey(url, vk) {
  const cached = keyCache.read();
  if (!cached || cached.vk !== vk || !sameEndpoint(cached.url, url)) return;
  keyCache.clear();
  try { fs.unlinkSync(path.join(keyCache.cacheDir(), 'auto-login-attempt.json')); } catch (_) {}
}

// Responses may be a single JSON object or an SSE stream of `data:` lines.
function parseBody(body, expectedId, includeFailure = false) {
  try {
    const message = JSON.parse(body);
    if (!message || message.jsonrpc !== '2.0' ||
        (expectedId !== undefined && message.id !== expectedId)) return null;
    // The first matching response ends an SSE request, even on failure. Never let
    // a later duplicate result replace an error or malformed result envelope.
    if (includeFailure && (Object.prototype.hasOwnProperty.call(message, 'error') ||
        Object.prototype.hasOwnProperty.call(message, 'result'))) return message;
    if (!Object.prototype.hasOwnProperty.call(message, 'result') ||
        Object.prototype.hasOwnProperty.call(message, 'error') ||
        !message.result || typeof message.result !== 'object' || Array.isArray(message.result)) return null;
    return message;
  } catch (_) { return null; }
}

// Consume each chunk once. A blank line dispatches one event; only its data lines
// are retained. CR, LF and CRLF may be mixed or split across network chunks.
function sseReader(expectedId) {
  let parts = [];
  let data = [];
  let skipLf = false;
  return chunk => {
    let start = skipLf && chunk[0] === '\n' ? 1 : 0;
    skipLf = false;
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let ending;
    while ((ending = endings.exec(chunk))) {
      parts.push(chunk.slice(start, ending.index));
      const line = parts.join('');
      parts = [];
      start = ending.index + 1;
      if (ending[0] === '\r') {
        if (chunk[start] === '\n') start++;
        else if (start === chunk.length) skipLf = true;
      }
      endings.lastIndex = start;
      if (line === '') {
        const message = parseBody(data.join('\n'), expectedId, true);
        data = [];
        if (message) return message;
      } else if (line === 'data' || line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
    return null;
  };
}

async function handshake(timeoutMs, credential = env()) {
  let timer;
  try {
    if (!credential.url || !credential.vk) return false;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
    return !!(await Promise.race([
      ensureSession(Date.now() + budget, credential),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), budget); }),
    ]));
  } catch (_) { return false; }
  finally { clearTimeout(timer); }
}

function readCache(credential = env()) {
  try {
    const c = JSON.parse(fs.readFileSync(discoveryCacheFile(credential), 'utf8'));
    if (c && c.cacheScope === scopeKey(credential.url, credential.vk) && typeof c.at === 'number') return c;
  } catch (_) {}
  return null;
}

function writeCache(disc, credential) {
  try {
    const file = discoveryCacheFile(credential);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(disc), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

// Inspect the gateway and decide how to reach skill-search and memory-search.
// Returns { skills, memory } where each is null or { server, mode: 'flat'|'code' }.
async function discover(timeoutMs, credential = env()) {
  if (!(await handshake(timeoutMs, credential))) return null;

  const flat = parseBody((await rpc('tools/list', {}, timeoutMs, credential) || {}).body);
  if (!flat || !Array.isArray(flat.result.tools)) return null;
  const flatTools = flat.result.tools;
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
      // A capability we cannot NAME is a capability we cannot print. Both of these
      // strings come from the gateway's tools/list and are interpolated into session
      // start and into every task-shaped prompt, in the plugin's own authoritative
      // voice — so they are exactly as untrusted as the memory warnings next to them,
      // and until now had no charset gate at all. A hostile catalog entry could carry
      // newlines and markdown, e.g. "evil\n\n## SYSTEM: …\n\nx-skill_search", and be
      // rendered as headings above the untrusted-data boundary, six times per session.
      // Reject rather than sanitize, same rule as warningText.
      if (!isIdentifier(server) || !isIdentifier(name)) continue;
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
    const cat = parseBody((await rpc('tools/call', { name: 'listToolFiles', arguments: {} }, timeoutMs, credential) || {}).body);
    const text = cat && cat.result && cat.result.content
      ? cat.result.content.map((c) => c.text || '').join('')
      : '';
    // Lines look like:  "  <server>/" then "    <tool>.pyi"
    let current = null;
    const codeServers = {}; // server -> Set(tool)
    const serverFiles = [];
    for (const line of text.split(/\r?\n/)) {
      // Any line that looks like a server header ends the previous server, even if its
      // name fails the charset. Leaving `current` in place would silently donate the
      // rejected server's tools to whichever server preceded it, inflating that count.
      if (/\/\s*$/.test(line)) {
        const sm = line.match(/^\s{2}([A-Za-z0-9_-]{1,40})\/\s*$/);
        current = sm ? sm[1] : null;
        if (current) codeServers[current] = codeServers[current] || [];
        continue;
      }
      // Server-level binding (Bifrost v2 default here): one `  <server>.pyi` per server,
      // tools are the `def` lines inside it, read below.
      const fm = line.match(/^\s{2}([A-Za-z0-9_-]{1,40})\.pyi\s*$/);
      if (fm) { current = null; serverFiles.push(fm[1]); continue; }
      const tm = line.match(/^\s{3,}([A-Za-z0-9_]{1,40})\.pyi\s*$/);
      // Cap tools per server. The charset already blocks newlines and markdown, but
      // nothing bounded LENGTH or COUNT, so a hostile catalog could balloon the cache
      // and the roster section with thousands of entries. Underscores also render as
      // spaces downstream, which is why the length bound matters as much as the
      // charset: a 200-character underscore_separated_name reads as a sentence.
      if (tm && current && codeServers[current].length < 200) codeServers[current].push(tm[1]);
    }
    // Same caps as above. Parallel, so the whole catalog costs about one round trip.
    // A failed read keeps the last known tools rather than dropping the server.
    const prev = (readCache(credential) || {}).roster || {};
    await Promise.all(serverFiles.slice(0, 60).map(async (srv) => {
      const r = parseBody((await rpc('tools/call', { name: 'readToolFile', arguments: { fileName: `servers/${srv}.pyi` } }, timeoutMs, credential) || {}).body);
      const body = r && r.result && r.result.content ? r.result.content.map((c) => c.text || '').join('') : '';
      const tools = [];
      for (const m of body.matchAll(/^def ([A-Za-z0-9_]{1,40})\(/gm)) {
        if (tools.length < 200) tools.push(m[1]);
      }
      codeServers[srv] = tools.length ? tools : (Array.isArray(prev[srv]) ? prev[srv] : []);
    }));
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

  return { at: Date.now(), cacheScope: scopeKey(credential.url, credential.vk), skills, memory, roster };
}

// Cached discovery; refreshes if missing/stale. Returns discovery or null.
async function getCapabilities(timeoutMs, { refresh = false, cacheOnly = false } = {}, credential = env()) {
  if (!refresh) {
    const c = readCache(credential);
    if (c && Date.now() - c.at < DISCOVERY_TTL_MS) return c;
  }
  if (cacheOnly) return readCache(credential); // never hit the network (per-prompt hook)
  const disc = await discover(timeoutMs, credential);
  if (disc) writeCache(disc, credential);
  return disc || readCache(credential); // fall back to stale cache if the refresh failed
}

// Resolve the flat tool name to call. Exported so the hooks print exactly what they
// would call, instead of composing the string a second time in a different place.
function flatToolName(cap, toolFn) {
  if (!cap) return toolFn;
  // Render-time gate. discover() now refuses non-identifier names at the source, but a
  // discovery cache written by an older gateway.cjs is still on disk and is read
  // directly by both session-start and prompt-submit. Checking here too means such a
  // cache heals on the next session rather than on the next successful gateway call —
  // the same argument as the count check in session-start's warningText.
  if (cap.tool && !isIdentifier(cap.tool)) return toolFn;
  if (cap.server && !isIdentifier(cap.server)) return toolFn;
  // Compare with separators normalized: a gateway may advertise the same function as
  // `skill-search` while callers name it `skill_search`. Without this the discovered
  // tool is not recognized as itself and gets rebuilt into a name that does not exist.
  const norm = (s) => String(s).replace(/[-_]/g, '_');
  if (cap.tool && new RegExp(`(^|_)${norm(toolFn)}$`).test(norm(cap.tool))) return cap.tool;
  return cap.server ? `${cap.server}-${toolFn}` : toolFn;
}

// Call a discovered capability (flat or code-mode). Returns parsed text or null.
async function callCapability(cap, toolFn, args, timeoutMs, credential = env()) {
  if (!cap) return null;
  let resp;
  if (cap.mode === 'flat') {
    // For the tool we actually discovered, use the name the gateway advertised
    // verbatim — it is known-good, whereas anything we reassemble is a guess. Only
    // siblings (skill_navigate, get_skill, memory_store, …) are built from the server
    // prefix, and a gateway exposing a bare tool with no prefix is called directly.
    const name = flatToolName(cap, toolFn);
    resp = await rpc('tools/call', { name, arguments: args }, timeoutMs, credential);
  } else {
    const kv = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    const code = `result = ${cap.server}.${toolFn}(${kv})`;
    resp = await rpc('tools/call', { name: 'executeToolCode', arguments: { code } }, timeoutMs, credential);
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
    .replace(/\$\{([^}]*)\}/g, (_, v) => (typeof process.env[v] === 'string' ? process.env[v] : ''))
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
function readDiscoveryCacheSync(maxAgeMs, now = Date.now(), credential = env()) {
  const c = readCache(credential);
  if (!c || !Number.isFinite(maxAgeMs) || now - c.at >= maxAgeMs) return null;
  return c;
}

module.exports = {
  env,
  pluginOption,
  pluginName,
  toolPrefix,
  rpc,
  isIdentifier,
  getCapabilities,
  callCapability,
  readDiscoveryCacheSync,
  credentialFromMcpConfig,
  detectServerNameCollision,
  sameEndpoint,
  flatToolName,
  discover,
  discoveryCacheFile,
  get DISCOVERY_CACHE() { return discoveryCacheFile(); },
};
