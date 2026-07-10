'use strict';
// Detached background worker. Refreshes the per-project "inject cache" that
// session-start reads: the skill-search invocation + a sample of the navigator
// domains, and a handful of recalled memory facts. Spawned by session-start.cjs
// and allowed to take as long as the backend needs — it runs AFTER the hook
// exits, so session start never waits on the gateway (which can be slow or down).
//
// Usage: node refresh.cjs <cacheFile> <memoryQuery>
// Writes {at, skills:{server,mode,branches[]},
// memory:{server,facts:[{content,similarity}]}, kb:{server,facts:[...]}} to
// the cache file. Silent-fail; always exits 0.
//
// KB recall reuses the same memory server/capability — there is no separate
// kb-mcp. It is just memory_search scoped to the KB wing (wing=<BIFROST_KB_WING>).
// No default wing name is assumed: KB recall is skipped entirely unless
// BIFROST_KB_WING is set, configurable via BIFROST_KB_WING / BIFROST_KB_QUERY.
//
// Sizing is adaptive (env-configurable, all optional):
//   BIFROST_MEMORY_MAX_FACTS  — cap on injected facts (default 6)
//   BIFROST_MEMORY_SNIPPET_LEN — base per-fact snippet length in chars (default 180)
//   BIFROST_INJECT_BUDGET     — total char budget per section (default ~2000,
//                               ~500 tokens at ~4 chars/token)
//   BIFROST_MEMORY_MIN_SIM    — drop results below this similarity (default 0.45)
//   BIFROST_MEMORY_FAST       — set to 1 to pass fast:true to memory_search
//                               (server-side fast path; opt-in until the live
//                               gateway ships the param — an unknown param on a
//                               strict schema would otherwise reject the call)
// We query with a wider k than we intend to keep, then greedily fill the
// budget from the highest-similarity results first, giving higher-scored
// facts a larger snippet allowance instead of a flat per-fact truncation.

const fs = require('fs');
const path = require('path');
const gw = require('./lib/gateway.cjs');

const TIMEOUT_MS = 45000; // bumped for k=12 fetches; detached worker, latency is free
const DEFAULT_MAX_FACTS = 6;
const DEFAULT_SNIPPET_LEN = 180;
const DEFAULT_BUDGET_CHARS = 2000; // ~500 tokens @ ~4 chars/token
const DEFAULT_MIN_SIM = 0.45;
const FETCH_K = 12; // fetch wider than MAX_FACTS so budget-fill has a pool to pick from
const MAX_BRANCHES = 10;

function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function envFloat(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

const MAX_FACTS = envInt('BIFROST_MEMORY_MAX_FACTS', DEFAULT_MAX_FACTS);
const SNIPPET_LEN = envInt('BIFROST_MEMORY_SNIPPET_LEN', DEFAULT_SNIPPET_LEN);
const BUDGET_CHARS = envInt('BIFROST_INJECT_BUDGET', DEFAULT_BUDGET_CHARS);
const MIN_SIM = envFloat('BIFROST_MEMORY_MIN_SIM', DEFAULT_MIN_SIM);
const USE_FAST = process.env.BIFROST_MEMORY_FAST === '1';

function clean(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Best-effort structured parse of a memory_search response: an array of
// {content|text, similarity|score} objects, optionally wrapped in
// {results:[...]} / {matches:[...]} / {facts:[...]}. Returns null (not an
// array) if the shape isn't recognized, so callers can fall back to the
// legacy regex scan.
function parseStructured(text) {
  if (!text) return null;
  let data;
  try { data = JSON.parse(text); } catch (_) { return null; }
  const arr = Array.isArray(data) ? data
    : Array.isArray(data && data.results) ? data.results
    : Array.isArray(data && data.matches) ? data.matches
    : Array.isArray(data && data.facts) ? data.facts
    : null;
  if (!arr) return null;
  return arr
    .map((item) => {
      if (typeof item === 'string') return { content: clean(item), similarity: null };
      if (!item || typeof item !== 'object') return null;
      const content = item.content != null ? item.content : item.text;
      if (!content) return null;
      const simRaw = typeof item.similarity === 'number' ? item.similarity
        : typeof item.score === 'number' ? item.score
        : null;
      return { content: clean(content), similarity: simRaw };
    })
    .filter((r) => r && r.content);
}

// Legacy fallback: regex-scan raw "content":"..." pairs when the response
// isn't parseable JSON in a recognized shape (unknown format, or a plain
// text blob). No similarity data available — every result is kept (matches
// pre-adaptive-sizing behavior) subject only to MAX_FACTS/SNIPPET_LEN.
function extractFactsLegacy(text) {
  if (!text) return [];
  const facts = [];
  const re = /"content"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(text)) && facts.length < FETCH_K) {
    let s;
    try { s = JSON.parse(m[1]); } catch (_) { continue; }
    s = clean(s);
    if (s) facts.push({ content: s, similarity: null });
  }
  return facts;
}

function truncate(s, len) {
  return s.length > len ? s.slice(0, len) + '…' : s;
}

// Greedily fill a char budget from the highest-similarity results first.
// Results with a numeric similarity below MIN_SIM are dropped; results with
// unknown similarity (legacy/unstructured responses) are always kept, so
// behavior degrades to "cap at MAX_FACTS, flat SNIPPET_LEN" — i.e. exactly
// the pre-adaptive-sizing behavior — when no similarity data is available.
function budgetFill(results) {
  const known = results.filter((r) => typeof r.similarity === 'number');
  const unknown = results.filter((r) => typeof r.similarity !== 'number');

  const kept = known.filter((r) => r.similarity >= MIN_SIM);
  kept.sort((a, b) => b.similarity - a.similarity);

  const pool = kept.concat(unknown); // scored-and-relevant first, then unscored
  const out = [];
  let charsUsed = 0;

  for (const r of pool) {
    if (out.length >= MAX_FACTS) break;
    const remaining = BUDGET_CHARS - charsUsed;
    if (remaining <= 20) break; // not enough room for a meaningful snippet

    // Higher-similarity facts get a larger snippet allowance (up to 2x base
    // at similarity 1.0); unscored facts get the flat base length.
    const bonus = typeof r.similarity === 'number' ? r.similarity : 0;
    const allowance = Math.min(Math.round(SNIPPET_LEN * (1 + bonus)), remaining);

    const content = truncate(r.content, allowance);
    if (!content) continue;
    out.push({ content, similarity: r.similarity });
    charsUsed += content.length;
  }
  return out;
}

// Query memory_search (optionally KB-wing-scoped) and return a sized,
// budget-filled fact list. Never throws — an unparseable/empty response just
// yields fewer or zero facts.
async function searchFacts(cap, query, wing) {
  // `k` and `detail` ('l0'/'l1'/'full') are widely-supported memory_search
  // params across gateway memory servers — safe to send unconditionally.
  // `fast` is not universally shipped server-side yet, so it stays env-gated
  // behind USE_FAST below.
  const args = { query, k: FETCH_K, detail: 'l1' };
  if (wing) args.wing = wing;
  if (USE_FAST) args.fast = true;
  const text = await gw.callCapability(cap, 'memory_search', args, TIMEOUT_MS);
  const structured = parseStructured(text);
  const results = structured || extractFactsLegacy(text);
  return budgetFill(results);
}

async function main() {
  const cacheFile = process.argv[2];
  const query = process.argv[3] || 'recent decisions gotchas conventions';
  if (!cacheFile) return;

  const { url, vk } = gw.env();
  if (!url || !vk) return;

  const caps = await gw.getCapabilities(TIMEOUT_MS);
  if (!caps) return;

  const out = { at: Date.now() };

  if (caps.skills) {
    const tree = await gw.callCapability(caps.skills, 'skill_navigate', {}, TIMEOUT_MS);
    const branches = (tree || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /skill_navigate\(node=/.test(l))
      .map((l) => l.replace(/^[•\-\*]\s*/, ''))
      .slice(0, MAX_BRANCHES);
    out.skills = { server: caps.skills.server, mode: caps.skills.mode, branches };
  }

  if (caps.memory) {
    out.memory = { server: caps.memory.server, facts: await searchFacts(caps.memory, query, null) };

    // No default wing name: KB recall is opt-in only, via an explicit
    // BIFROST_KB_WING configured for this gateway's KB scope.
    const kbWing = (process.env.BIFROST_KB_WING || '').trim();
    const kbQuery = (process.env.BIFROST_KB_QUERY || query || '').trim();
    if (kbWing) {
      out.kb = { server: caps.memory.server, facts: await searchFacts(caps.memory, kbQuery, kbWing) };
    }
  }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  } catch (_) {}
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}

module.exports = { parseStructured, extractFactsLegacy, budgetFill, truncate };
