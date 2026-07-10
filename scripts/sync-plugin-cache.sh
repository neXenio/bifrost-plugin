#!/usr/bin/env bash
# sync-plugin-cache.sh — point the installed plugin cache at this checkout's HEAD
# so dev-from-checkout works without a marketplace reinstall.
#
# Claude Code resolves an installed plugin via:
#   ~/.claude/plugins/installed_plugins.json  ->  "bifrost-plugin@bifrost-marketplace"[].installPath
#   ~/.claude/plugins/cache/bifrost-marketplace/bifrost-plugin/<version>/
# This script symlinks that versioned cache dir at the *current plugin.json
# version* to this checkout, and updates installPath/version/lastUpdated in
# installed_plugins.json so Claude Code loads live checkout content instead of
# the stale marketplace-installed copy.
#
# Safe to re-run. Never touches anything outside the bifrost-plugin entries.
# Ref: adapted from an internal reference implementation (git-sha based); this
# plugin's cache dirs are keyed by semver, not commit sha, so we key on the
# version field in .claude-plugin/plugin.json instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED_JSON="$HOME/.claude/plugins/installed_plugins.json"
CACHE_BASE="$HOME/.claude/plugins/cache/bifrost-marketplace/bifrost-plugin"
PLUGIN_JSON="$SCRIPT_DIR/.claude-plugin/plugin.json"

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "sync-plugin-cache: $PLUGIN_JSON not found — not a bifrost-plugin checkout" >&2
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('$PLUGIN_JSON'))['version'])")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

mkdir -p "$CACHE_BASE"
ln -snf "$SCRIPT_DIR" "$CACHE_BASE/$VERSION"

if [ -f "$INSTALLED_JSON" ]; then
  python3 - "$INSTALLED_JSON" "$SCRIPT_DIR" "$VERSION" "$NOW" << 'PYEOF'
import json, sys

path, checkout, version, now = sys.argv[1:]

with open(path) as f:
    data = json.load(f)

entries = data.get("plugins", {}).get("bifrost-plugin@bifrost-marketplace", [])
for entry in entries:
    entry["installPath"] = f"{checkout}"
    entry["version"] = version
    entry["lastUpdated"] = now

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
  echo "sync-plugin-cache: installed_plugins.json updated -> $SCRIPT_DIR ($VERSION)"
else
  echo "sync-plugin-cache: $INSTALLED_JSON not found — symlink created, skipping installed_plugins.json update" >&2
fi

echo "sync-plugin-cache: symlink $CACHE_BASE/$VERSION -> $SCRIPT_DIR"
