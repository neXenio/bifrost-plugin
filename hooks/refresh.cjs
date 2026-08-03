'use strict';
// Detached background worker. Refreshes the per-project "inject cache" that
// session-start reads: the skill-search invocation + a sample of the navigator
// domains, and a handful of recalled memory facts. Spawned by session-start.cjs
// and allowed to take as long as the backend needs — it runs AFTER the hook
// exits, so session start never waits on the gateway (which can be slow or down).
//
// Usage: node refresh.cjs <cacheFile> <memoryQuery>
// Writes {at, skills:{server,mode[,count]},
// memory:{server,mode,total,facts:[{content,similarity}][,stale,staleSince]},
// kb:{...}} to the cache file. Silent-fail; always exits 0.
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
//   BIFROST_MEMORY_MIN_SIM    — drop results below this similarity (default 0, i.e.
//                               no floor; scores are not comparable across servers)
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
const pc = require('./lib/plugin-config.cjs');

const TIMEOUT_MS = 45000; // bumped for k=12 fetches; detached worker, latency is free
const DEFAULT_MAX_FACTS = 6;
const DEFAULT_SNIPPET_LEN = 180;
const DEFAULT_BUDGET_CHARS = 2000; // ~500 tokens @ ~4 chars/token
// No similarity floor by default. Relevance scores are not comparable across memory
// servers — cosine, dot-product and BM25-fused scores do not share a scale, and this
// gateway's own measured range (0.381-0.415) sat entirely BELOW the previous 0.45
// default, so every scored fact was dropped and the memory section silently rendered
// empty. Ranking plus MAX_FACTS and the char budget already bound what gets injected;
// a hard threshold on an unknown scale only ever removed good results. Set
// BIFROST_MEMORY_MIN_SIM if a specific server's scale justifies one.
const DEFAULT_MIN_SIM = 0;
const FETCH_K = 12; // fetch wider than MAX_FACTS so budget-fill has a pool to pick from
// How long facts may be carried forward across empty refreshes before we stop
// injecting them. Bounds retention when a gateway stays broken.
const MAX_CARRY_FORWARD_MS = 7 * 24 * 60 * 60 * 1000;

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

function formatProvenance(provenance) {
  if (typeof provenance === 'string') return clean(provenance);
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return '';
  return [
    ['subject', provenance.subject],
    ['wing', provenance.wing],
    ['room', provenance.room],
    ['created_at', provenance.created_at],
  ]
    .filter(([, value]) => typeof value === 'string' && clean(value))
    .map(([key, value]) => `${key}=${clean(value)}`)
    .join(', ');
}

// Best-effort structured parse of a memory_search response: an array of
// {content|text|fact, similarity|score|authority[, provenance]} objects,
// optionally wrapped in {results:[...]} / {matches:[...]} / {facts:[...]}.
// Non-fact elements such as {_system_warnings:[...]} are ignored. Returns null
// (not an array) if the shape isn't recognized, so callers can fall back to
// the legacy regex scan.
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
      let content = item.content != null ? item.content : item.text;

      if (!content && item.fact) {
        content = item.fact;
        const provenance = formatProvenance(item.provenance);
        if (provenance) content = `${content} (Provenance: ${provenance})`;
      }

      if (!content) return null;
      const simRaw = typeof item.similarity === 'number' ? item.similarity
        : typeof item.score === 'number' ? item.score
        : typeof item.authority === 'number' ? item.authority
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
  const re = /"(?:content|fact)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
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

  // Signed plugin-config refresh. Independent of the inject cache below (different
  // endpoint, different env), so it runs first and unconditionally — a gateway with
  // BIFROST_KEYAPP_URL but no BIFROST_URL still gets its policy refreshed. Fails closed
  // internally: a bad signature/hash leaves the last verified cache untouched.
  try { await pc.refreshAndRecord({}); } catch (_) {}

  if (!cacheFile) return;

  const { url, vk } = gw.env();
  if (!url || !vk) return;

  const caps = await gw.getCapabilities(TIMEOUT_MS);
  if (!caps) return;

  const out = { at: Date.now() };

  if (caps.skills) {
    // No library size here on purpose. Telling the model "N skills available" is the
    // cheapest way to make searching obviously worth a tool call, but this gateway
    // exposes no way to learn N: the skills server has only get_skill, skill_navigate
    // and skill_search; skill_search reports only its own hit count and caps results
    // at 20 regardless of `k`; and counting via the navigator costs 200+ calls per
    // user per refresh. Reinstate a count here the moment the skills server exposes
    // one — session-start already renders it when `count` is present.
    out.skills = { server: caps.skills.server, mode: caps.skills.mode };
  }

  if (caps.memory) {
    out.memory = {
      server: caps.memory.server,
      mode: caps.memory.mode,
      facts: await searchFacts(caps.memory, query, null),
    };
    // Corpus size, for the same reason as the skill count: it tells the model whether
    // the shared memory is worth querying. memory_stats is cheap and widely present;
    // absence just means the size line is omitted.
    const stats = await gw.callCapability(caps.memory, 'memory_stats', {}, TIMEOUT_MS);
    try {
      const s = JSON.parse(stats);
      const total = (s.hot_count || 0) + (s.cold_count || 0);
      if (total > 0) out.memory.total = total;
    } catch (_) { /* no stats tool, or a shape we don't read — size line omitted */ }

    // No default wing name: KB recall is opt-in only, via an explicit
    // BIFROST_KB_WING configured for this gateway's KB scope.
    const kbWing = (process.env.BIFROST_KB_WING || '').trim();
    const kbQuery = (process.env.BIFROST_KB_QUERY || query || '').trim();
    if (kbWing) {
      out.kb = { server: caps.memory.server, facts: await searchFacts(caps.memory, kbQuery, kbWing) };
    }
  }

  // Never let a degraded response destroy a good cache. A single hiccup used to
  // overwrite six healthy facts with an empty list AND refresh the timestamp, so the
  // blanked cache then read as valid for another day while looking deliberate.
  // Mirrors the fail-closed contract the signed plugin-config path already has.
  try {
    const prev = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    mergeWithPrevious(out, prev);
  } catch (_) { /* no previous cache — nothing to preserve */ }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  } catch (_) {}
}

// Carry forward the previous cache where this run produced nothing usable. Split out
// of main() so it can be tested without a gateway. Mutates `out`.
function mergeWithPrevious(out, prev, now = Date.now()) {
  if (!prev || typeof prev !== 'object') return out;
  {
    for (const section of ['memory', 'kb']) {
      // Only ever carry facts forward for a capability THIS run still produced. If the
      // section is absent the capability is gone — memory revoked from the key, or the
      // KB wing switched off — and resurrecting it would keep injecting data the user
      // is no longer entitled to. Deprovisioning has to actually deprovision.
      if (!out[section]) continue;

      const fresh = Array.isArray(out[section].facts) ? out[section].facts : [];
      const old = prev && prev[section] && Array.isArray(prev[section].facts) ? prev[section].facts : [];
      if (fresh.length || !old.length) continue;

      // Bound the carry-forward. Without a ceiling a permanently broken gateway serves
      // day-one facts forever, and each rewrite refreshes the timestamp, so nothing
      // ever looks stale to anyone.
      const since = Number.isFinite(prev[section].staleSince) ? prev[section].staleSince
        : (Number.isFinite(prev.at) ? prev.at : now);
      if (now - since > MAX_CARRY_FORWARD_MS) continue; // let it go empty

      out[section] = Object.assign({}, out[section], { facts: old, stale: true, staleSince: since });
    }

    if (out.memory && !out.memory.total && prev && prev.memory && prev.memory.total) {
      out.memory.total = prev.memory.total;
    }
    if (out.skills && !out.skills.count && prev && prev.skills && prev.skills.count) {
      out.skills.count = prev.skills.count;
    }

    // Do not present carried-over content as a fresh fetch. session-start's staleness
    // notice keys off the cache timestamp, so refreshing it on a run that produced
    // nothing new would silence the very warning added to make this visible.
    const carried = ['memory', 'kb'].some((k) => out[k] && out[k].stale);
    if (carried && Number.isFinite(prev.at)) out.at = prev.at;
  }
  return out;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}

module.exports = { parseStructured, extractFactsLegacy, budgetFill, truncate, mergeWithPrevious, MAX_CARRY_FORWARD_MS };
