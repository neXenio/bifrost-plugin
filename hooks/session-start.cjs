'use strict';
// SessionStart hook — emits guidance/bifrost-context.md to stdout for CC
// context injection. Best-effort, silent-fail. Always exits 0.
//
// Memory recall and save are agent-driven via the gateway's memory MCP tools.
// See AGENTS.md for the memory workflow.

const fs = require('fs');
const path = require('path');

function emitContext() {
  try {
    const contextPath = path.join(__dirname, '..', 'guidance', 'bifrost-context.md');
    process.stdout.write(fs.readFileSync(contextPath, 'utf8'));
  } catch (_) {
    // File missing or unreadable — emit nothing, do not block session start.
  }
}

async function main() {
  emitContext();
  process.exit(0);
}

main().catch(() => process.exit(0));
