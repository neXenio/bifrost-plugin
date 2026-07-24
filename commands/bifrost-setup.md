---
description: Set up the Bifrost MCP gateway — register the server via claude mcp add and verify memory + skill discovery are live.
---

# /bifrost-setup

Set up a Bifrost MCP gateway for Claude Code and confirm memory + skill
discovery are live. This command is the ONLY place onboarding runs — the
plugin never launches setup on its own.

## What this command does

1. Checks whether the `bifrost` MCP server is already registered (`claude mcp get bifrost`).
2. If missing, registers it via `claude mcp add --scope user` (idempotent — re-running replaces the same entry).
3. Reminds you to set `BIFROST_URL` / `BIFROST_VK` in your shell profile.
4. Guides you to verify the connection.

## One-command onboarding

```bash
# Point BIFROST_URL at your gateway, then run the installer wrapper:
export BIFROST_URL=https://<your-gateway-host>/mcp
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js" --key vk_<your-key>

# Or without a key (VK must already be in env):
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js"
```

This wraps exactly one command — `claude mcp add --scope user --transport http
bifrost "$BIFROST_URL" --header "x-bf-vk: …"` — and never edits config files
itself. Without `--key`, the `${BIFROST_VK}` runtime template is stored and the
key stays only in your shell environment.

If your gateway operator has configured an SSO keyapp (`BIFROST_KEYAPP_URL`),
you can instead run the browser-based provisioning flow explicitly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/auto-setup.cjs"
```

It opens the keyapp in your browser, receives your key on a loopback-only,
nonce-gated listener, and registers the server via `claude mcp add`.

## After install

1. Add `export BIFROST_VK=<your-key>` to `~/.zshrc` or `~/.bashrc` (skip if you used `--key` or the SSO flow)
2. Restart Claude Code
3. Verify by running this command again or typing "set up bifrost"

## Verification checklist

- `claude mcp list` (or `/mcp`) shows the `bifrost` server
- The gateway's skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) is reachable (MCP loaded)
- SessionStart injects bifrost context at the top of each session
- Memory tools (if your gateway exposes a memory server) are callable via `mcp__bifrost__<memory-server>-search`

## Troubleshoot

Type **"bifrost not working"** to invoke the `bifrost-debug` skill for a guided diagnosis.
Type **"manually add bifrost mcp"** to invoke `bifrost-mcp-setup` for manual wiring steps.

## Key source

Obtain your gateway URL and VK from your gateway operator.
Without `--key`, the key is never stored in any file — it lives only in your
shell environment as `BIFROST_VK`.
