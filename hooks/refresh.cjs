'use strict';
// Detached background worker. Refreshes the per-project "inject cache" that
// session-start reads: the skill-search invocation + a sample of the navigator
// domains, and a handful of recalled memory facts. Spawned by session-start.cjs
// and allowed to take as long as the backend needs — it runs AFTER the hook
// exits, so session start never waits on the gateway (which can be slow or down).
//
// Usage: node refresh.cjs <cacheFile> <memoryQuery>
// Writes {at, skills:{server,mode,branches[]}, memory:{server,facts[]}} to the
// cache file. Silent-fail; always exits 0.

const fs = require('fs');
const path = require('path');
const gw = require('./lib/gateway.cjs');

const TIMEOUT_MS = 30000;
const MAX_FACTS = 6;
const MAX_BRANCHES = 10;
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
    const text = await gw.callCapability(caps.memory, 'memory_search', { query, k: MAX_FACTS }, TIMEOUT_MS);
    const facts = extractFacts(text);
    out.memory = { server: caps.memory.server, facts };
  }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  } catch (_) {}
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
