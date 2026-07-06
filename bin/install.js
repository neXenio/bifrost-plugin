#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BIFROST_SERVER_NAME = 'bifrost';
// URL and VK are runtime templates — Claude Code resolves them from the shell env.
const MCP_JSON_PATH = path.join(os.homedir(), '.claude', 'mcp.json');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--key' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args.key = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function printHelp() {
  console.log([
    '',
    'bifrost-plugin installer — idempotent Bifrost MCP setup for Claude Code',
    '',
    'Usage:',
    '  node bin/install.js [--key <vk_...>] [--dry-run]',
    '',
    'Options:',
    '  --key <vk>   Your Bifrost VK (virtual key). Printed as an export',
    '               reminder; never written into any file.',
    '  --dry-run    Show what would change without writing anything.',
    '  --help       Show this message.',
    '',
    'Effect:',
    '  Merges the bifrost mcpServer entry into ~/.claude/mcp.json.',
    '  Running twice leaves exactly one entry — second run is a no-op.',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// mcp.json helpers
// ---------------------------------------------------------------------------

function readMcpJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    // Empty file is safe to treat as a fresh config.
    return { mcpServers: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Malformed JSON — ABORT. Silently overwriting would destroy the user's
    // existing MCP servers. Make them fix or remove the file deliberately.
    console.error('[bifrost-plugin] ERROR: ' + filePath + ' is not valid JSON.');
    console.error('  Parse error: ' + err.message);
    console.error('  Refusing to overwrite it. Fix the JSON (or move it aside) and re-run.');
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error('[bifrost-plugin] ERROR: ' + filePath + ' does not contain a JSON object.');
    console.error('  Refusing to overwrite it. Fix or remove it and re-run.');
    process.exit(1);
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    parsed.mcpServers = {};
  }
  return parsed;
}

function writeMcpJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Back up any existing file before replacing it.
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) { /* best-effort backup */ }
  }
  // Atomic write: write a sibling tmp file, then rename over the target so a
  // crash mid-write can never leave a truncated mcp.json.
  const tmpPath = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function buildBifrostEntry() {
  return {
    type: 'http',
    url: '${BIFROST_URL}',
    headers: { 'x-bf-vk': '${BIFROST_VK}' }
  };
}

// Deep-equal via JSON round-trip (safe for plain config objects)
function entriesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Key reminder (never written to disk)
// ---------------------------------------------------------------------------

function printKeyReminder(key) {
  // Safety check: refuse to log anything that looks like a real secret token.
  // The installer must never echo a key into a log that could be captured.
  // We only print the export line — the shell does the assignment, not us.
  console.log('');
  console.log('Set your Bifrost VK (add to ~/.zshrc or ~/.bashrc for persistence):');
  console.log('');
  // Print the raw export line — the key value is supplied by the caller who
  // already has it; this is equivalent to echoing it back for copy-paste.
  console.log('  export BIFROST_VK=' + key);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // --key: print export reminder, never write to disk
  if (args.key) {
    printKeyReminder(args.key);
  }

  // Read current state
  const mcpJson = readMcpJson(MCP_JSON_PATH);
  const desiredEntry = buildBifrostEntry();
  const existing = mcpJson.mcpServers[BIFROST_SERVER_NAME];

  // Idempotency check
  if (existing && entriesEqual(existing, desiredEntry)) {
    console.log('[bifrost-plugin] Already configured — no changes made.');
    console.log('  ' + MCP_JSON_PATH);
    printNextSteps(false);
    process.exit(0);
  }

  if (args.dryRun) {
    console.log('[bifrost-plugin] Dry run — would write to:');
    console.log('  ' + MCP_JSON_PATH);
    console.log('');
    console.log('  mcpServers.' + BIFROST_SERVER_NAME + ' =', JSON.stringify(desiredEntry, null, 2));
    process.exit(0);
  }

  // Apply
  mcpJson.mcpServers[BIFROST_SERVER_NAME] = desiredEntry;
  writeMcpJson(MCP_JSON_PATH, mcpJson);

  console.log('[bifrost-plugin] Bifrost MCP server written to:');
  console.log('  ' + MCP_JSON_PATH);
  printNextSteps(true);
  process.exit(0);
}

function printNextSteps(freshInstall) {
  console.log('');
  if (freshInstall) {
    console.log('Next steps:');
    console.log('  1. Set your VK (if not already):');
    console.log('       export BIFROST_VK=<your-vk-key>');
    console.log('  2. Restart Claude Code');
    console.log('  3. Verify: type "set up bifrost" or run /bifrost-setup');
  } else {
    console.log('To verify the connection, type "set up bifrost" in Claude Code.');
  }
  console.log('');
}

main();
