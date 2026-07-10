# Hook verification

Hooks shipped by this plugin, the events they fire on, and the conventions
every hook in `hooks/hooks.json` must follow. Ported from an internal
reference hook-conventions doc, scoped to what this plugin actually ships.

## Events wired (`hooks/hooks.json`)

| Event | Command | Confirmed |
|-------|---------|-----------|
| `SessionStart` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.cjs"` | Fires once per new Claude Code session. Emits `guidance/bifrost-context.md`, the skills/memory/KB cache headers, spawns the detached `refresh.cjs` worker, and (dev checkouts only) the detached `scripts/sync-plugin-cache.sh` self-heal. |
| `UserPromptSubmit` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-submit.cjs"` | Fires on every user prompt submission. Emits the skill-discovery hint for task-verb prompts. |

Not wired: `SessionEnd`, `PreToolUse`, `PostToolUse`, `SubagentStart/Stop` —
this plugin has no need for them today. Do not add a hook for an event this
table doesn't list without updating this doc.

## Conventions

1. **`$CLAUDE_PLUGIN_ROOT` everywhere.** Every hook command path is rooted at
   `${CLAUDE_PLUGIN_ROOT}`, never a hardcoded absolute path — the plugin must
   work identically whether installed via the marketplace (versioned cache
   dir) or run from a dev checkout (`scripts/sync-plugin-cache.sh`).
2. **Explicit per-hook `timeout`.** Every hook entry in `hooks.json` sets an
   explicit `timeout` (seconds) so a hung hook cannot stall the Claude Code
   UI indefinitely. `SessionStart`/`UserPromptSubmit` here do zero blocking
   network I/O by design (see `session-start.cjs`, `prompt-submit.cjs`), so
   timeouts are a defense-in-depth backstop, not the primary latency control.
3. **Silent-fail, always exit 0.** Every hook's `main()` is wrapped in
   try/catch and always calls `process.exit(0)` — a thrown error or a slow/
   down gateway must never block or fail the user's session or prompt.
4. **Detached background work never blocks the hook.** Anything that talks to
   the network (`refresh.cjs`, `auto-setup.cjs`) or touches the plugin cache
   (`sync-plugin-cache.sh`) is spawned `detached: true, stdio: 'ignore'` and
   `.unref()`'d so the parent hook process can exit immediately.
