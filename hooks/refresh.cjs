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
//   BIFROST_MEMORY_WARN_THRESHOLD — fallback count a `_system_warnings` entry must
//                               reach before it is cached for injection, for any
//                               warning type with no tuned bound of its own
//   BIFROST_MEMORY_WARN_THRESHOLD_<TYPE> — per-type override, e.g.
//                               BIFROST_MEMORY_WARN_THRESHOLD_STALE_MEMORIES=200;
//                               see DEFAULT_WARN_THRESHOLDS/actionableWarnings below
// We query with a wider k than we intend to keep, then greedily fill the
// budget from the highest-similarity results first, giving higher-scored
// facts a larger snippet allowance instead of a flat per-fact truncation.
//
// luca-memory is a passive store: it never runs its own maintenance, only
// advertises what needs doing, by appending a `{"_system_warnings":[...]}` entry to
// the end of every memory_search response (parseStructured already drops this as a
// non-fact; see its comment). We are the one component that talks to memory_search
// on every session, so we are the only place that can notice. Surfacing every
// warning unconditionally would become wallpaper across ~60 agents mostly mid-task
// on unrelated work, so each type has to clear its own bound before it gets cached
// (DEFAULT_WARN_THRESHOLDS below).
// Deliberately NOT a memory_call(action="meta.stats") round trip: the "the
// session-start refresh never calls memory_call" test pins refresh.cjs to
// memory_search alone, and this data already rides along for free on that call.

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
// Per warning type, because the three luca-memory actually emits
// (memory_lib.get_system_warnings: pending_contradictions, stale_memories,
// unprocessed_staged) all carry a numeric count and none of their counts mean the
// same thing. One shared bound cannot serve them: at 50 it muted
// pending_contradictions outright — a single unresolved contradiction is two
// memories asserting opposite things, actionable at count 1 and never reaching 50.
//   pending_contradictions: 1  — the corpus is self-inconsistent; always say so.
//   stale_memories: 50 — 181 unflagged for three weeks (the incident that motivated
//     this) is well past due; single/low-double-digit staleness is ordinary churn in
//     a corpus this many agents write to continuously.
//   unprocessed_staged: 10 — one or two staged sessions is just a session that ended;
//     a double-digit pile means /coach has not run in a long while.
const DEFAULT_WARN_THRESHOLDS = {
  pending_contradictions: 1,
  stale_memories: 50,
  unprocessed_staged: 10,
};
// Fallback bound for a warning type luca-memory grows later that has no tuned
// default here yet. Better to over-report an unknown type once than to swallow it.
const DEFAULT_WARN_THRESHOLD = 1;
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
// {content|text, relevance|similarity|score[, provenance]} objects, optionally
// wrapped in {results:[...]} / {matches:[...]} / {facts:[...]}. Non-fact elements
// such as {_system_warnings:[...]} are ignored. Returns null (not an array) if the
// shape isn't recognized, so callers can fall back to the legacy regex scan.
// `similarity`/`score` are other gateways' spellings, not luca-memory compatibility.
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
      if (!content) return null;

      const provenance = formatProvenance(item.provenance);
      if (provenance) content = `${content} (Provenance: ${provenance})`;

      const simRaw = typeof item.relevance === 'number' ? item.relevance
        : typeof item.similarity === 'number' ? item.similarity
        : typeof item.score === 'number' ? item.score
        : null;
      return { content: clean(content), similarity: simRaw };
    })
    .filter((r) => r && r.content);
}

// A warning entry needs a string `type` or `message` to be recognized as one at
// all — anything else (null, an array, a bare number) is not warning-shaped and is
// dropped rather than guessed at.
function isWarningLike(w) {
  return !!w && typeof w === 'object' && !Array.isArray(w)
    && (typeof w.type === 'string' || typeof w.message === 'string');
}

// Best-effort extraction of the `_system_warnings` array luca-memory appends as an
// extra element to every memory_search response (see module doc above, and
// parseStructured's comment, which treats this same element as a non-fact and drops
// it). Mirrors parseStructured's container unwrapping (bare array, or
// {results|matches|facts:[...]}) since the warning element rides alongside whichever
// shape the facts came back in. Returns [] on anything unparseable or unrecognized.
function extractSystemWarnings(text) {
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch (_) { return []; }
  const containers = [
    Array.isArray(data) ? data : null,
    Array.isArray(data && data.results) ? data.results : null,
    Array.isArray(data && data.matches) ? data.matches : null,
    Array.isArray(data && data.facts) ? data.facts : null,
  ];
  for (const c of containers) {
    if (!c) continue;
    for (const item of c) {
      if (item && typeof item === 'object' && Array.isArray(item._system_warnings)) {
        return item._system_warnings.filter(isWarningLike);
      }
    }
  }
  // Defensive fallback: a top-level {_system_warnings:[...]} property rather than an
  // array element. Not the documented shape, but cheap to accept.
  if (data && typeof data === 'object' && Array.isArray(data._system_warnings)) {
    return data._system_warnings.filter(isWarningLike);
  }
  return [];
}

// The bound one warning type must clear, most specific source first:
// BIFROST_MEMORY_WARN_THRESHOLD_<TYPE>, then the global BIFROST_MEMORY_WARN_THRESHOLD
// (a single knob for an operator who wants uniform quiet), then the type's tuned
// default, then DEFAULT_WARN_THRESHOLD. Read per call rather than at module load so
// a caller can set the env and see it take effect.
function warnThreshold(type) {
  const tuned = Object.prototype.hasOwnProperty.call(DEFAULT_WARN_THRESHOLDS, type)
    ? DEFAULT_WARN_THRESHOLDS[type]
    : DEFAULT_WARN_THRESHOLD;
  const global = envInt('BIFROST_MEMORY_WARN_THRESHOLD', tuned);
  const key = String(type || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return key ? envInt(`BIFROST_MEMORY_WARN_THRESHOLD_${key}`, global) : global;
}

// Threshold gate: a count-bearing warning clears its own type's bar or stays silent.
// Every type luca-memory emits today carries a count; a hypothetical future type
// without one has nothing to compare against, so it is kept rather than silently
// dropped — a bad reason to show something beats no reason to hide it.
function actionableWarnings(warnings) {
  return warnings.filter(
    (w) => typeof w.count !== 'number' || w.count >= warnThreshold(w.type)
  );
}

// Last resort: regex-scan raw "content":"..." pairs when the response isn't
// parseable JSON in a recognized shape (unknown format, or a plain text blob).
// No similarity data available — every result is kept (matches pre-adaptive-sizing
// behavior) subject only to MAX_FACTS/SNIPPET_LEN.
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
//
// `warningsOut`, if given an array, gets any `_system_warnings` found on this
// response pushed into it (unfiltered by threshold — callers decide). Optional and
// additive so existing callers/tests passing 3 args are unaffected.
async function searchFacts(cap, query, wing, warningsOut) {
  // luca-memory v0.42 argument shape. Anything older rejects it and recall goes empty;
  // /bifrost-debug section 8 names that symptom.
  const args = { query, limit: FETCH_K, detail: 'l1' };
  if (wing) args.filters = { wing };
  if (USE_FAST) args.fast = true;
  const text = await gw.callCapability(cap, 'memory_search', args, TIMEOUT_MS);
  if (Array.isArray(warningsOut)) warningsOut.push(...extractSystemWarnings(text));
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
    const rawWarnings = [];
    out.memory = {
      server: caps.memory.server,
      mode: caps.memory.mode,
      facts: await searchFacts(caps.memory, query, null, rawWarnings),
    };
    // No corpus size: v0.42 moved memory_stats behind memory_call, and the hot path
    // stays on memory_search alone. session-start renders without it.

    // Maintenance backlog luca-memory advertised on this same call (see module doc).
    // Only what clears actionableWarnings' bar gets cached — session-start renders
    // whatever is here unconditionally, so the threshold decision lives here, once.
    const warnings = actionableWarnings(rawWarnings);
    if (warnings.length) out.memory.warnings = warnings;

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

module.exports = {
  parseStructured, extractFactsLegacy, budgetFill, truncate, mergeWithPrevious,
  MAX_CARRY_FORWARD_MS, searchFacts, extractSystemWarnings, actionableWarnings,
};
