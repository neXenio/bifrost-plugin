'use strict';
// Stop hook — STAGE-THEN-PROCESS pattern (mirrors ~/.memory/hooks/consolidate.sh).
// Stages session reflection payload to disk on Stop (zero network on exit path).
// Next SessionStart picks up staging files and ingests them into the memory service.
// Rate-limited: one reflection per session_id (marker file guard).
// Always exits 0. Never surfaces errors. Prints {"continue":true}.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Memory service base URL — configurable via BIFROST_MEMORY_URL, defaults to the
// conventional local service on 127.0.0.1:52421 (localhost only). Only referenced
// in the staged instructions below; this hook does no network on the exit path.
const MEMORY_BASE = (process.env.BIFROST_MEMORY_URL || 'http://127.0.0.1:52421').replace(/\/+$/, '');
const CACHE_BASE = path.join(os.homedir(), '.cache', 'bifrost-plugin');
const STAGING_DIR = path.join(CACHE_BASE, 'staging');
const REFLECTED_DIR = path.join(CACHE_BASE, 'reflected');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function safeMarkerName(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function main() {
  const raw = await readStdin();

  let event = {};
  try { event = JSON.parse(raw); } catch { /* silent */ }

  const sessionId =
    event.session_id || event.sessionId ||
    `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

  const workingDir = event.cwd || event.working_directory || process.cwd();
  const project = path.basename(workingDir);
  const transcriptPath = event.transcript_path || event.transcriptPath || null;

  ensureDir(REFLECTED_DIR);

  // Rate-limit: one reflection per session
  const markerFile = path.join(REFLECTED_DIR, safeMarkerName(sessionId));
  if (fs.existsSync(markerFile)) {
    // Already reflected for this session — skip without staging a duplicate.
    process.stdout.write('{"continue":true}\n');
    process.exit(0);
    return;
  }

  // Write marker immediately to prevent duplicate reflections if Stop fires twice.
  try { fs.writeFileSync(markerFile, new Date().toISOString()); } catch { /* ignore */ }

  // Stage payload for ingest at next SessionStart (file I/O only — no network on exit path).
  ensureDir(STAGING_DIR);
  const stageFile = path.join(
    STAGING_DIR,
    `${safeMarkerName(sessionId)}-${Date.now()}.json`
  );

  const payload = {
    schema_version: 1,
    source: 'bifrost-plugin-session-reflect',
    session_id: sessionId,
    project,
    working_directory: workingDir,
    staged_at: new Date().toISOString(),
    transcript_path: transcriptPath,
    session_data: event,
    // Instructions for the SessionStart processor that picks this file up:
    // Consumed by hooks/session-start.cjs: it reads `facts` (an array of
    // distilled strings, when present) and POSTs each to the memory service write
    // route <BIFROST_MEMORY_URL>/memory/store, which applies its own noise
    // classifier + semantic dedup before persisting.
    facts: [],
    reflect_instructions: [
      'Extract durable facts from this session for the memory service.',
      'Include: decisions made, root causes found, conventions learned, gotchas discovered.',
      'Exclude: transient chatter, secrets, per-file noise, one-off implementation details.',
      'Cap output at 8 items. Each item must be reusable knowledge.',
      'Dedup: the memory store rejects near-duplicates (similarity > 0.95) on its own.',
      `Accepted facts are POSTed to ${MEMORY_BASE}/memory/store.`,
    ],
  };

  try {
    fs.writeFileSync(stageFile, JSON.stringify(payload, null, 2), 'utf8');
  } catch { /* silent-fail: disk full, permissions — staging loss is acceptable */ }

  process.stdout.write('{"continue":true}\n');
  process.exit(0);
}

main().catch(() => {
  process.stdout.write('{"continue":true}\n');
  process.exit(0);
});
