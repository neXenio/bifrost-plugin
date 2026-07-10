# Settings policy — scope-drift guard

Negative-list policy enforced by `scripts/settings-lint.sh`. Regex patterns
(POSIX ERE) checked against two scopes so the plugin never leaks the wrong
thing into the wrong Claude Code settings scope.

Adapted from an internal reference implementation of a multi-scope MCP config
drift guard; this plugin only has one real scope-drift risk, so the policy
below is narrower and specific to bifrost-plugin.

## Scope: REPO

This git-tracked checkout (source of truth for the marketplace + npm package).

Forbidden — must never be committed:

```
vk_[A-Za-z0-9]{10,}
sk-bf-[A-Za-z0-9]{10,}
```

Real virtual-key material. `.mcp.json` must always ship the runtime templates
`${BIFROST_URL}` / `${BIFROST_VK}`, resolved by Claude Code from the user's
own environment — never a literal key or resolved URL snapshot.

## Scope: USER

The per-machine `~/.claude/mcp.json` and `~/.claude/settings.json`.

Forbidden — must never be hardcoded there:

```
<this checkout's absolute filesystem path>
```

These files are meant to be portable across machines/developers; a dev's
local clone path leaking in (e.g. from `bin/install.js` misbehaving, or the
dev-checkout self-heal in `scripts/sync-plugin-cache.sh` touching the wrong
file) would break the config on anyone else's machine.

## Severity

- Any match is an **ERROR** — `scripts/settings-lint.sh` exits `1`.
- No file present is a **SKIP**, not an error (e.g. `~/.claude/mcp.json`
  legitimately absent before first install).

## Update workflow

Change a pattern in this doc → update the matching array in
`scripts/settings-lint.sh` → run the lint locally → fix drift → commit both
together.
