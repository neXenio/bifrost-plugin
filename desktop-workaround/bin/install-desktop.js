#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BIFROST_SERVER_NAME = 'bifrost';
/** Pin for reproducibility; must match setup.sh prefetch. */
const MCP_REMOTE_VERSION = '0.1.38';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args.url = argv[i + 1];
      i++;
    } else if (argv[i] === '--key' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
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
    'Bifrost Claude Desktop installer — writes claude_desktop_config.json',
    '',
    'Usage:',
    '  node bin/install-desktop.js --url <gateway-mcp-url> --key <vk_...> [--dry-run]',
    '',
    'Options:',
    '  --url <url>   Bifrost gateway MCP endpoint (must include /mcp path)',
    '  --key <vk>    Your personal virtual key (stored in config env block)',
    '  --dry-run     Show what would change without writing anything',
    '  --help        Show this message',
    '',
    'Effect:',
    '  Merges a local mcp-remote stdio proxy into claude_desktop_config.json.',
    '  Running twice with the same url/key is a no-op.',
    '',
    'Prefer ./setup.sh — it also installs Node and prefetches mcp-remote when needed.',
    '',
    'macOS only.',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function desktopConfigPath() {
  if (process.platform !== 'darwin') {
    console.error('[bifrost-desktop] ERROR: This installer supports macOS only.');
    process.exit(1);
  }
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json'
  );
}

function desktopConfigDir(configPath) {
  return path.dirname(configPath);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readDesktopConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return { mcpServers: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[bifrost-desktop] ERROR: ' + filePath + ' is not valid JSON.');
    console.error('  Parse error: ' + err.message);
    console.error('  Refusing to overwrite it. Fix the JSON (or move it aside) and re-run.');
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error('[bifrost-desktop] ERROR: ' + filePath + ' does not contain a JSON object.');
    process.exit(1);
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    parsed.mcpServers = {};
  }
  return parsed;
}

function writeDesktopConfig(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) { /* best-effort */ }
  }
  const tmpPath = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best-effort */ }
}

function resolveNpxCommand() {
  if (process.env.BIFROST_DESKTOP_NPX) {
    return process.env.BIFROST_DESKTOP_NPX;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'npx'),
    '/opt/homebrew/bin/npx',
    '/usr/local/bin/npx',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_) { /* continue */ }
  }
  try {
    const resolved = execSync('command -v npx', {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (resolved) return resolved;
  } catch (_) { /* fall through */ }
  console.error('[bifrost-desktop] WARNING: could not resolve npx path — using "npx".');
  console.error('  Claude Desktop may fail to start the bridge if Node is only in ~/.local/bin.');
  return 'npx';
}

function buildBifrostEntry(gatewayUrl, vk) {
  const npx = resolveNpxCommand();
  return {
    command: npx,
    args: [
      '-y',
      'mcp-remote@' + MCP_REMOTE_VERSION,
      gatewayUrl,
      '--transport',
      'http-only',
      '--header',
      'x-bf-vk:${BIFROST_VK}',
    ],
    env: {
      BIFROST_VK: vk,
    },
  };
}

function entriesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    console.error('[bifrost-desktop] ERROR: --url is required.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    console.error('[bifrost-desktop] ERROR: --url is not a valid URL: ' + url);
    process.exit(1);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.error('[bifrost-desktop] ERROR: --url must use http or https.');
    process.exit(1);
  }
  if (!parsed.pathname.endsWith('/mcp')) {
    console.error('[bifrost-desktop] WARNING: URL should usually end with /mcp (got ' + parsed.pathname + ').');
  }
  return url.trim();
}

function validateKey(key) {
  if (!key || typeof key !== 'string') {
    console.error('[bifrost-desktop] ERROR: --key is required.');
    process.exit(1);
  }
  const trimmed = key.trim();
  if (/PASTE_YOUR_VK|YOUR_KEY_HERE|CHANGE_ME|<your-key>|vk_<your/i.test(trimmed)) {
    console.error('[bifrost-desktop] ERROR: replace the placeholder with your real virtual key from the setup site.');
    process.exit(1);
  }
  if (!/^(vk_|sk-bf-)/.test(trimmed)) {
    console.error('[bifrost-desktop] WARNING: key does not look like vk_… or sk-bf-… — continuing anyway.');
  }
  return trimmed;
}

function printNextSteps(configPath, freshInstall) {
  console.log('');
  if (freshInstall) {
    console.log('Next steps:');
    console.log('  1. Fully quit Claude Desktop (not just close the window)');
    console.log('  2. Reopen Claude Desktop');
    console.log('  3. Look for the hammer icon in the chat input');
    console.log('  4. Ask: "What bifrost MCP tools do you have?"');
  } else {
    console.log('Configuration unchanged. Restart Claude Desktop if you still do not see bifrost tools.');
  }
  console.log('');
  console.log('Config file: ' + configPath);
  console.log('(Contains your virtual key — keep this file private.)');
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

  const gatewayUrl = validateUrl(args.url);
  const vk = validateKey(args.key);
  const configPath = desktopConfigPath();
  const configDir = desktopConfigDir(configPath);
  const dirExisted = fs.existsSync(configDir);

  const desktopConfig = readDesktopConfig(configPath);
  const desiredEntry = buildBifrostEntry(gatewayUrl, vk);
  const existing = desktopConfig.mcpServers[BIFROST_SERVER_NAME];

  if (existing && entriesEqual(existing, desiredEntry)) {
    console.log('[bifrost-desktop] Already configured — no changes made.');
    printNextSteps(configPath, false);
    process.exit(0);
  }

  if (args.dryRun) {
    console.log('[bifrost-desktop] Dry run — would write to:');
    console.log('  ' + configPath);
    console.log('');
    console.log('  mcpServers.' + BIFROST_SERVER_NAME + ' =', JSON.stringify(desiredEntry, null, 2));
    console.log('');
    console.log('  npx resolved to: ' + resolveNpxCommand());
    if (!dirExisted) {
      console.log('');
      console.log('Note: Claude config directory does not exist yet.');
      console.log('Enable Developer mode first: Claude Desktop → Settings → Developer.');
    }
    process.exit(0);
  }

  desktopConfig.mcpServers[BIFROST_SERVER_NAME] = desiredEntry;
  writeDesktopConfig(configPath, desktopConfig);

  console.log('[bifrost-desktop] Bifrost MCP server written to:');
  console.log('  ' + configPath);

  if (!dirExisted) {
    console.log('');
    console.log('First-time setup: if Claude Desktop does not load MCP servers,');
    console.log('enable Developer mode: Settings → Developer.');
  }

  printNextSteps(configPath, true);
  process.exit(0);
}

main();
