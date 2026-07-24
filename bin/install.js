#!/usr/bin/env node
'use strict';
// Fallback installer for setups that don't use the marketplace plugin path
// (the plugin's own .mcp.json self-wires when the plugin is enabled, so most
// users never need this). Registers the bifrost MCP server through Claude
// Code's own CLI (`claude mcp add --scope user`) instead of editing any config
// file directly — this plugin never writes to files under ~/.claude/.

const { execFileSync } = require('child_process');

const BIFROST_SERVER_NAME = 'bifrost';

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
    'bifrost-plugin installer — registers the Bifrost MCP server via `claude mcp add`',
    '',
    'Usage:',
    '  BIFROST_URL=https://<gateway>/mcp node bin/install.js [--key <vk_...>] [--dry-run]',
    '',
    'Options:',
    '  --key <vk>   Your Bifrost VK (virtual key). Stored in the server entry',
    '               auth header. Without it, the ${BIFROST_VK} runtime template',
    '               is used and the key stays only in your shell environment.',
    '  --dry-run    Show the `claude mcp add` command without running it.',
    '  --help       Show this message.',
    '',
    'Effect:',
    '  Runs: claude mcp add --scope user --transport http bifrost <url> \\',
    '          --header "x-bf-vk: <key>"',
    '  Re-running replaces the same entry — safe to run multiple times.',
    '',
  ].join('\n'));
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

  const url = (process.env.BIFROST_URL || '').trim();
  if (!url) {
    console.error('[bifrost-plugin] ERROR: BIFROST_URL is not set.');
    console.error('  export BIFROST_URL=https://<your-gateway-host>/mcp and re-run.');
    process.exit(1);
  }

  // Without --key the header keeps the runtime template, so the key itself is
  // never persisted anywhere — it stays in the shell env as BIFROST_VK.
  const headerValue = args.key ? args.key : '${BIFROST_VK}';
  const cliArgs = [
    'mcp', 'add', '--scope', 'user', '--transport', 'http',
    BIFROST_SERVER_NAME, url, '--header', `x-bf-vk: ${headerValue}`,
  ];

  const shown = cliArgs
    .map((a) => {
      if (a !== `x-bf-vk: ${headerValue}`) return a;
      return args.key ? '"x-bf-vk: <your-key>"' : '"x-bf-vk: ${BIFROST_VK}"';
    })
    .join(' ');

  if (args.dryRun) {
    console.log('[bifrost-plugin] Dry run — would execute:');
    console.log('  claude ' + shown);
    process.exit(0);
  }

  try {
    execFileSync('claude', cliArgs, { stdio: 'inherit', timeout: 15000 });
  } catch (err) {
    console.error('[bifrost-plugin] ERROR: `claude mcp add` failed.');
    console.error('  Is the Claude Code CLI on your PATH? You can run it yourself:');
    console.error('  claude ' + shown);
    process.exit(1);
  }

  console.log('[bifrost-plugin] Bifrost MCP server registered (user scope).');
  printNextSteps(!args.key);
  process.exit(0);
}

function printNextSteps(needsEnvKey) {
  console.log('');
  console.log('Next steps:');
  if (needsEnvKey) {
    console.log('  1. Set your VK in your shell profile: export BIFROST_VK=<your-vk-key>');
    console.log('  2. Restart Claude Code');
    console.log('  3. Verify: run /bifrost-setup');
  } else {
    console.log('  1. Restart Claude Code');
    console.log('  2. Verify: run /bifrost-setup');
  }
  console.log('');
}

main();
