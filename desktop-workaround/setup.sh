#!/usr/bin/env bash
# One-shot Bifrost → Claude Desktop setup (macOS): Node + mcp-remote prefetch + config.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[bifrost-desktop] ERROR: This script supports macOS only." >&2
  exit 1
fi

REPO_RAW_BASE="${BIFROST_DESKTOP_RAW_BASE:-https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-workaround}"
MCP_REMOTE_VERSION="0.1.38"

URL=""
KEY=""
DRY_RUN=0

usage() {
  cat <<EOF

Bifrost Claude Desktop setup (macOS)

Usage:
  curl -fsSL ${REPO_RAW_BASE}/setup.sh -o ~/bifrost-desktop-setup.sh
  chmod +x ~/bifrost-desktop-setup.sh
  ~/bifrost-desktop-setup.sh --url <https://gateway-host/mcp>
  (prompts for your virtual key — avoids putting it in shell history)

  Or: ~/bifrost-desktop-setup.sh --url ... --key <vk_...> [--dry-run]

Options:
  --url <url>    Bifrost gateway /mcp endpoint (required)
  --key <vk>     Virtual key (optional — prompted securely if omitted and stdin is a TTY)
  --dry-run      Preview config without writing
  --help         Show this message

Also accepts BIFROST_VK in the environment instead of --key.
Piping curl directly to bash requires --key or BIFROST_VK (prefer download + run above).

EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)
      URL="${2:-}"
      shift 2
      ;;
    --key)
      KEY="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[bifrost-desktop] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$URL" ]; then
  echo "[bifrost-desktop] ERROR: --url is required." >&2
  usage >&2
  exit 1
fi

if [ -z "$KEY" ] && [ -n "${BIFROST_VK:-}" ]; then
  KEY="$BIFROST_VK"
fi

if [ -z "$KEY" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    read -rsp "Virtual key (vk_…, input hidden): " KEY
    echo ""
  else
    echo "[bifrost-desktop] ERROR: no virtual key provided." >&2
    echo "  Download the script and run it interactively (recommended):" >&2
    echo "    curl -fsSL ${REPO_RAW_BASE}/setup.sh -o ~/bifrost-desktop-setup.sh" >&2
    echo "    chmod +x ~/bifrost-desktop-setup.sh" >&2
    echo "    ~/bifrost-desktop-setup.sh --url <gateway-mcp-url>" >&2
    echo "  Or pass --key / set BIFROST_VK when piping to bash." >&2
    exit 1
  fi
fi

if echo "$KEY" | grep -qiE 'PASTE_YOUR_VK|YOUR_KEY_HERE|CHANGE_ME|<your-key>'; then
  echo "[bifrost-desktop] ERROR: replace the placeholder with your real virtual key." >&2
  exit 1
fi

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
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[bifrost-desktop] Dry run — skipping mcp-remote prefetch."
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

resolve_installer() {
  local script_path="${BASH_SOURCE[0]:-}"
  if [ -n "$script_path" ] && [ -f "$script_path" ]; then
    local dir
    dir="$(cd "$(dirname "$script_path")" && pwd)"
    if [ -f "${dir}/bin/install-desktop.js" ]; then
      echo "${dir}/bin/install-desktop.js"
      return 0
    fi
  fi

  local cache="${HOME}/.cache/bifrost-desktop-workaround"
  mkdir -p "$cache"
  local dest="${cache}/install-desktop.js"
  echo "[bifrost-desktop] Fetching config installer from GitHub ..."
  curl -fsSL "${REPO_RAW_BASE}/bin/install-desktop.js" -o "${dest}.tmp"
  mv "${dest}.tmp" "$dest"
  echo "$dest"
}

ensure_node
prefetch_mcp_remote
developer_mode_hint

INSTALLER="$(resolve_installer)"

INSTALL_ARGS=(--url "$URL" --key "$KEY")
if [ "$DRY_RUN" -eq 1 ]; then
  INSTALL_ARGS+=(--dry-run)
fi

exec node "$INSTALLER" "${INSTALL_ARGS[@]}"
