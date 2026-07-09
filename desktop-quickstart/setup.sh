#!/usr/bin/env bash
# Temporary Claude Desktop <-> Bifrost gateway bridge (pre-OAuth workaround).
# macOS only. See README.md in this directory for the coworker-facing guide.
#
# Single self-contained file: piping this straight from GitHub into bash is the
# supported flow (curl -fsSL <raw-url> | bash). Your virtual key is asked for with
# a hidden prompt read from /dev/tty, so it works even when piped (stdin is
# occupied by curl in that case) and it never lands in shell history.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[bifrost-desktop] ERROR: This script supports macOS only." >&2
  exit 1
fi

# Swap to https://bifrost.luca-app.de/mcp once the stable domain is live.
GATEWAY_URL="https://bifrostadmin108.share.zrok.io/mcp"
VK_SITE="https://bifrostphil108.share.zrok.io"
MCP_REMOTE_VERSION="0.1.38"

KEY=""
URL="$GATEWAY_URL"
DRY_RUN=0
UNINSTALL=0
CONFIG_PATH="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"

usage() {
  cat <<EOF

Bifrost Claude Desktop setup (temporary, pre-OAuth workaround)

Usage:
  curl -fsSL <raw-url>/setup.sh | bash
  (prompts for your virtual key with hidden input)

  Or non-interactively:
  setup.sh --key <vk_...> [--url <gateway-mcp-url>] [--dry-run]
  setup.sh --uninstall

Options:
  --key <vk>     Your personal virtual key from ${VK_SITE}
                 (omit to be prompted securely instead)
  --url <url>    Override the gateway /mcp endpoint (default: ${GATEWAY_URL})
  --dry-run      Show what would change without writing anything
  --uninstall    Remove the bifrost entry from claude_desktop_config.json
  --config-path <path>  Override the config file location (for testing)
  --help         Show this message

Also accepts BIFROST_VK in the environment instead of --key.

EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --config-path) CONFIG_PATH="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "[bifrost-desktop] Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# --- Key resolution: --key flag > BIFROST_VK env > hidden /dev/tty prompt ---
if [ "$UNINSTALL" -eq 0 ]; then
  if [ -z "$KEY" ] && [ -n "${BIFROST_VK:-}" ]; then
    KEY="$BIFROST_VK"
  fi

  if [ -z "$KEY" ]; then
    # `[ -r /dev/tty ]` only checks permission bits — it can pass even when no
    # controlling terminal is attached (e.g. CI, some sandboxes), where the
    # actual open then fails with a raw "Device not configured" bash error.
    # Attempt the open as an `if` condition (so set -e doesn't abort on
    # failure) and grouped so bash's own diagnostic is suppressed too.
    if { exec 3< /dev/tty; } 2>/dev/null; then
      read -rsp "Virtual key (vk_..., input hidden): " KEY <&3
      exec 3<&-
      echo ""
    fi
    if [ -z "$KEY" ]; then
      echo "[bifrost-desktop] ERROR: no virtual key provided and no terminal available to prompt." >&2
      echo "  Get your key from ${VK_SITE}, then pass it explicitly:" >&2
      echo "    setup.sh --key <vk_...>" >&2
      echo "  or set BIFROST_VK in your environment first." >&2
      exit 1
    fi
  fi

  if [ -z "$KEY" ] || echo "$KEY" | grep -qiE 'PASTE_YOUR_VK|YOUR_KEY_HERE|CHANGE_ME|<your-key>'; then
    echo "[bifrost-desktop] ERROR: no valid virtual key provided." >&2
    echo "  Get your key from ${VK_SITE} and try again." >&2
    exit 1
  fi
  if ! [[ "$KEY" =~ ^(vk_|sk-bf-) ]]; then
    echo "[bifrost-desktop] WARNING: key does not look like vk_... or sk-bf-... — continuing anyway." >&2
  fi
fi

# --- Node bootstrap: use existing 18+, else auto-install LTS to ~/.local (no sudo) ---
node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -e "process.stdout.write(String(parseInt(process.versions.node.split('.')[0], 10)))"
}

ensure_node() {
  local major
  major="$(node_major)"
  if [ "${major:-0}" -ge 18 ] 2>/dev/null; then
    return 0
  fi

  echo "[bifrost-desktop] Node 18+ not found — installing LTS to \$HOME/.local (no sudo) ..."
  export PATH="${HOME}/.local/bin:${PATH}"

  if ! curl -sfLS https://install-node.vercel.app/lts | bash -s -- -y --prefix="${HOME}/.local"; then
    echo "[bifrost-desktop] ERROR: automatic Node install failed." >&2
    echo "  Install manually from https://nodejs.org/ then re-run this script." >&2
    exit 1
  fi

  export PATH="${HOME}/.local/bin:${PATH}"
  major="$(node_major)"
  if [ "${major:-0}" -lt 18 ] 2>/dev/null; then
    echo "[bifrost-desktop] ERROR: Node installed but still not on PATH or version < 18." >&2
    echo "  Open a new terminal and re-run, or install from https://nodejs.org/" >&2
    exit 1
  fi

  echo "[bifrost-desktop] Node $(node -v) ready."
}

prefetch_mcp_remote() {
  if [ "$UNINSTALL" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  echo "[bifrost-desktop] Prefetching mcp-remote@${MCP_REMOTE_VERSION} (first Desktop launch will be faster) ..."
  if ! npx -y "mcp-remote@${MCP_REMOTE_VERSION}" --help >/dev/null 2>&1; then
    echo "[bifrost-desktop] WARNING: mcp-remote prefetch failed — Desktop may download it on first use." >&2
  fi
}

developer_mode_hint() {
  local config_dir="${HOME}/Library/Application Support/Claude"
  if [ ! -d "$config_dir" ]; then
    echo ""
    echo "First-time Claude Desktop MCP: enable Developer mode"
    echo "  Claude Desktop → Settings → Developer"
    echo ""
  fi
}

if [ "$UNINSTALL" -eq 0 ]; then
  ensure_node
  prefetch_mcp_remote
  developer_mode_hint
fi

# --- JSON merge, delegated to Node for safe parsing (never hand-roll JSON in bash) ---
MERGE_SCRIPT="$(mktemp -t bifrost-desktop-merge.XXXXXX.js)"
trap 'rm -f "$MERGE_SCRIPT"' EXIT

cat > "$MERGE_SCRIPT" <<'NODE_EOF'
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const [, , configPath, mode, url, key] = process.argv;
const SERVER_NAME = 'bifrost';
const MCP_REMOTE_VERSION = process.env.BIFROST_MCP_REMOTE_VERSION;

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) return { mcpServers: {} };
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return { mcpServers: {} };
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
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') parsed.mcpServers = {};
  return parsed;
}

function writeConfig(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) { /* best-effort */ }
  }
  const tmpPath = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best-effort */ }
}

// Claude Desktop is launched via Launch Services / Dock — its process gets a
// minimal PATH that may not include a user-local or Homebrew npx. Resolve an
// absolute path so the bridge can actually spawn once Desktop restarts.
function resolveNpxCommand() {
  if (process.env.BIFROST_DESKTOP_NPX) return process.env.BIFROST_DESKTOP_NPX;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'npx'),
    '/opt/homebrew/bin/npx',
    '/usr/local/bin/npx',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
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

function buildEntry(gatewayUrl, vk) {
  return {
    command: resolveNpxCommand(),
    args: [
      '-y',
      'mcp-remote@' + MCP_REMOTE_VERSION,
      gatewayUrl,
      '--transport',
      'http-only',
      '--header',
      'x-bf-vk:${BIFROST_VK}',
    ],
    env: { BIFROST_VK: vk },
  };
}

function entriesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const config = readConfig(configPath);

if (mode === 'uninstall' || mode === 'uninstall-dry-run') {
  if (!config.mcpServers[SERVER_NAME]) {
    console.log('[bifrost-desktop] No bifrost entry present — nothing to remove.');
    process.exit(0);
  }
  if (mode === 'uninstall-dry-run') {
    console.log('[bifrost-desktop] Dry run — would remove bifrost from:');
    console.log('  ' + configPath);
    process.exit(0);
  }
  delete config.mcpServers[SERVER_NAME];
  writeConfig(configPath, config);
  console.log('[bifrost-desktop] Removed bifrost from ' + configPath);
  process.exit(0);
}

const desired = buildEntry(url, key);
const existing = config.mcpServers[SERVER_NAME];

if (existing && entriesEqual(existing, desired)) {
  console.log('[bifrost-desktop] Already configured — no changes made.');
  console.log('  ' + configPath);
  process.exit(0);
}

if (mode === 'dry-run') {
  console.log('[bifrost-desktop] Dry run — would write to:');
  console.log('  ' + configPath);
  console.log('');
  console.log('  mcpServers.' + SERVER_NAME + ' =', JSON.stringify(desired, null, 2));
  process.exit(0);
}

config.mcpServers[SERVER_NAME] = desired;
writeConfig(configPath, config);

console.log('[bifrost-desktop] Bifrost MCP server written to:');
console.log('  ' + configPath);
console.log('');
console.log('Next steps:');
console.log('  1. Fully quit Claude Desktop (not just close the window)');
console.log('  2. Reopen Claude Desktop');
console.log('  3. Look for the hammer/tools icon in the chat input');
console.log('  4. Ask: "What bifrost MCP tools do you have?"');
console.log('');
console.log('(' + configPath + ' now contains your virtual key — keep it private.)');
NODE_EOF

MODE="install"
if [ "$UNINSTALL" -eq 1 ] && [ "$DRY_RUN" -eq 1 ]; then
  MODE="uninstall-dry-run"
elif [ "$UNINSTALL" -eq 1 ]; then
  MODE="uninstall"
elif [ "$DRY_RUN" -eq 1 ]; then
  MODE="dry-run"
fi

BIFROST_MCP_REMOTE_VERSION="$MCP_REMOTE_VERSION" node "$MERGE_SCRIPT" "$CONFIG_PATH" "$MODE" "$URL" "$KEY"
