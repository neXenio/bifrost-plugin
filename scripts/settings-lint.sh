#!/bin/sh
# bifrost-plugin Settings-Lint — scope-drift guard.
# Policy: docs/settings-policy.md
# Exit codes: 0 = clean, 1 = violations found, 2 = invalid input.
#
# Adapted from an internal reference implementation (multi-scope MCP config
# drift guard) for bifrost-plugin's two real leak surfaces:
#   REPO scope  — this git-tracked checkout must never contain a literal
#                 virtual key (vk_.../sk-bf-...) or a hardcoded gateway URL in
#                 .mcp.json (must stay the ${BIFROST_URL}/${BIFROST_VK} template).
#   USER scope  — the per-machine ~/.claude/mcp.json and ~/.claude/settings.json
#                 must never hardcode this checkout's local filesystem path
#                 (that's a dev-machine leak into config meant to be portable).
#
# KNOWN BUG FIXED ON PORT: the reference implementation incremented a hit counter
# inside `printf ... | while read; do count=$((count+1)); done`. Because the
# left side of a pipe runs the `while` in a subshell, every increment was
# lost once the subshell exited — violations were silently undercounted
# (always read back as 0). Fixed here by reading patterns into a shell array
# via `set --` (no pipe, no subshell) and counting matches with `grep -c`
# directly against the source file, so the counter lives in the main shell.

set -u

REPO_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
USER_MCP="$HOME/.claude/mcp.json"
USER_SETTINGS="$HOME/.claude/settings.json"

# Forbidden patterns per scope (POSIX ERE, one per line via `set --`, no subshell).
# REPO: real virtual-key material must never be committed.
REPO_PATTERNS='vk_[A-Za-z0-9]{10,}
sk-bf-[A-Za-z0-9]{10,}'

# USER: the plugin's own dev checkout path must never be hardcoded into the
# per-machine global config (that config is meant to reference the installed
# plugin, not a specific developer's clone).
user_pattern_for_repo() {
  # Escape the repo path for use as an ERE literal.
  printf '%s\n' "$1" | sed -e 's/[.[\*^$()+?{|]/\\&/g'
}

errors=0
check_errors=0

# count_matches <file> <pattern> — echoes a match count, or "err" if the file
# couldn't be scanned. Callers invoke this via `n=$(count_matches ...)`, which
# runs the function in a subshell, so it cannot set check_errors itself (that
# assignment would be lost the moment the subshell exits) — callers must
# sanitize the echoed value and set check_errors in the main shell.
# `-a` forces grep to treat binary files as text (BSD grep prints "Binary
# file X matches" instead of a count otherwise); the "err" sentinel still
# guards against any non-numeric result.
count_matches() {
  file="$1"
  pattern="$2"
  [ -f "$file" ] || { echo 0; return; }
  if [ ! -r "$file" ]; then
    printf 'WARNING: unreadable file, skipping: %s\n' "$file" >&2
    echo err
    return
  fi
  n=$(grep -Eac "$pattern" "$file" 2>/dev/null)
  case "$n" in
    ''|*[!0-9]*)
      printf 'WARNING: could not determine match count for %s, treating as 0\n' "$file" >&2
      echo err
      return
      ;;
  esac
  echo "$n"
}

lint_repo() {
  echo "=== REPO scope: $REPO_DIR ==="
  if [ ! -d "$REPO_DIR" ]; then
    echo "[REPO] SKIP — directory not found: $REPO_DIR"
    return
  fi
  files=$(cd "$REPO_DIR" && git ls-files 2>/dev/null)
  if [ -z "$files" ]; then
    echo "[REPO] SKIP — not a git checkout or no tracked files"
    return
  fi

  # Read newline-separated patterns into positional params — no subshell.
  IFS='
'
  set -- $REPO_PATTERNS
  unset IFS

  for pattern in "$@"; do
    [ -z "$pattern" ] && continue
    hits=0
    for f in $files; do
      full="$REPO_DIR/$f"
      [ -f "$full" ] || continue
      case "$full" in *.png|*.jpg|*.jpeg|*.gif|*.ico|*.pdf) continue ;; esac
      n=$(count_matches "$full" "$pattern")
      case "$n" in ''|*[!0-9]*) check_errors=1; n=0 ;; esac
      if [ "$n" -gt 0 ]; then
        printf '[REPO] FORBIDDEN: pattern `%s` matched in %s (%s hit(s))\n' "$pattern" "$f" "$n"
        hits=$((hits + n))
      fi
    done
    errors=$((errors + hits))
  done
}

lint_user() {
  echo ""
  echo "=== USER scope: $USER_MCP, $USER_SETTINGS ==="
  repo_pattern=$(user_pattern_for_repo "$REPO_DIR")

  for file in "$USER_MCP" "$USER_SETTINGS"; do
    if [ ! -f "$file" ]; then
      printf '[USER] SKIP — file not found: %s\n' "$file"
      continue
    fi
    n=$(count_matches "$file" "$repo_pattern")
    case "$n" in ''|*[!0-9]*) check_errors=1; n=0 ;; esac
    if [ "$n" -gt 0 ]; then
      printf '[USER] FORBIDDEN: dev checkout path leaked into %s (%s hit(s))\n' "$file" "$n"
      errors=$((errors + n))
    fi
  done
}

lint_repo
lint_user

echo ""
echo "=== Summary ==="
echo "Total violations: $errors"

if [ "$errors" -gt 0 ]; then
  exit 1
fi

if [ "$check_errors" -eq 1 ]; then
  echo "Some files could not be scanned — see WARNING lines above." >&2
  exit 2
fi

exit 0
