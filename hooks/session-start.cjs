'use strict';
// SessionStart hook — two jobs, in order:
//   1. Emit guidance/bifrost-context.md to stdout for CC context injection.
//   2. Drain the reflection staging dir: POST staged session facts to the memory
//      service, then move each file to processed/. This is the consumer side of
//      the Pillar-4 flywheel (producer is hooks/session-reflect.cjs).
// Best-effort, short network timeout, silent-fail. ALWAYS exits 0 and ALWAYS
// emits the context first so a slow/absent memory service never costs context.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Memory service base URL — configurable via BIFROST_MEMORY_URL, defaults to the
// conventional local service on 127.0.0.1:52421 (localhost only). The write route
// `/memory/store` is a documented convention: it accepts {text, tags, dedup, ...}
// and applies its own noise classifier + semantic dedup, so we forward facts
// verbatim and let the service gate quality.
const MEMORY_BASE = (process.env.BIFROST_MEMORY_URL || 'http://127.0.0.1:52421').replace(/\/+$/, '');
const MEMORY_STORE_URL = MEMORY_BASE + '/memory/store';
const POST_TIMEOUT_MS = 1000;
const MAX_KEEP = 50; // cap on processed/ + reflected/ retention

const CACHE_BASE = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const STAGING_DIR = path.join(CACHE_BASE, 'staging');
const PROCESSED_DIR = path.join(CACHE_BASE, 'processed');
const REFLECTED_DIR = path.join(CACHE_BASE, 'reflected');

function emitContext() {
  try {
    const contextPath = path.join(__dirname, '..', 'guidance', 'bifrost-context.md');
    process.stdout.write(fs.readFileSync(contextPath, 'utf8'));
  } catch (_) {
    // File missing or unreadable — emit nothing, do not block session start.
  }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function postJson(urlStr, payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const body = JSON.stringify(payload);
      const u = new URL(urlStr);
      const req = http.request(
        {
          hostname: u.hostname,
          port: parseInt(u.port, 10) || 80,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 300));
        }
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.write(body);
      req.end();
    } catch { done(false); }
  });
}

// Pull postable fact strings out of a staged reflection payload. We never
// fabricate facts: only forward content the producer actually distilled. The
// memory service noise-gates + dedups, so this stays conservative.
function extractFacts(payload) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim().length >= 10) out.push(v.trim());
  };
  if (payload && Array.isArray(payload.facts)) payload.facts.forEach(push);
  if (payload && typeof payload.reflect_summary === 'string') push(payload.reflect_summary);
  return out.slice(0, 8);
}

async function ingestStagedFile(filePath) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return; // unreadable/corrupt — leave it; do not crash
  }

  const facts = extractFacts(payload);
  const tags = ['source:bifrost-plugin-reflect'];
  if (payload && payload.project) tags.push(`project:${payload.project}`);

  for (const text of facts) {
    // Best-effort; the memory service dedups so re-posts are harmless.
    // eslint-disable-next-line no-await-in-loop
    await postJson(MEMORY_STORE_URL, { text, tags, dedup: true }, POST_TIMEOUT_MS);
  }

  // Move to processed/ regardless of POST outcome to keep staging bounded and
  // avoid re-posting storms. The memory service is the source of truth.
  try {
    ensureDir(PROCESSED_DIR);
    fs.renameSync(filePath, path.join(PROCESSED_DIR, path.basename(filePath)));
  } catch {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// Cap a directory to the most recent MAX_KEEP files (by mtime); delete older.
function capDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { full, mtime };
    });
  } catch {
    return; // dir missing — nothing to cap
  }
  if (entries.length <= MAX_KEEP) return;
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const { full } of entries.slice(MAX_KEEP)) {
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
}

async function drainStaging() {
  let files;
  try {
    files = fs.readdirSync(STAGING_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return; // no staging dir yet — nothing to do
  }
  for (const name of files) {
    // eslint-disable-next-line no-await-in-loop
    await ingestStagedFile(path.join(STAGING_DIR, name));
  }
  capDir(PROCESSED_DIR);
  capDir(REFLECTED_DIR);
}

async function main() {
  // Context FIRST — never let memory work delay or suppress it.
  emitContext();
  try {
    await drainStaging();
  } catch { /* silent-fail */ }
  process.exit(0);
}

main().catch(() => process.exit(0));
