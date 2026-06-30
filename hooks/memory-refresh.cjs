'use strict';
// Detached background worker: query the gateway memory server and write the
// recalled facts to a cache file. Spawned by session-start.cjs and intentionally
// allowed to take as long as the backend needs (memory search can be slow under
// load) — it never blocks session start because it runs after the hook exits.
//
// Usage: node memory-refresh.cjs <cacheFile> <query>
// Writes {at, query, facts:[...]} to <cacheFile>. Silent-fail; always exits 0.

const fs = require('fs');
const path = require('path');
const gw = require('./lib/gateway.cjs');

const TIMEOUT_MS = 30000;
const MAX_FACTS = 6;
const SNIPPET_LEN = 180;

function extractFacts(text) {
  if (!text) return [];
  const facts = [];
  const re = /"content"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(text)) && facts.length < MAX_FACTS) {
    let s;
    try { s = JSON.parse(m[1]); } catch (_) { continue; }
    s = s.replace(/\s+/g, ' ').trim();
    if (s) facts.push(s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN) + '…' : s);
  }
  return facts;
}

async function main() {
  const cacheFile = process.argv[2];
  const query = process.argv[3] || 'recent decisions gotchas conventions';
  if (!cacheFile) return;

  const { url, vk } = gw.env();
  if (!url || !vk) return;

  const caps = await gw.getCapabilities(TIMEOUT_MS);
  if (!caps || !caps.memory) return;

  const text = await gw.callCapability(caps.memory, 'memory_search', { query, k: MAX_FACTS }, TIMEOUT_MS);
  const facts = extractFacts(text);
  if (!facts.length) return;

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    // stamp time without Date.now sugar issues — Date is available in a normal node process
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), query, server: caps.memory.server, facts }), 'utf8');
  } catch (_) {}
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
