# /bifrost-setup

Set up a Bifrost MCP gateway for Claude Code. Runs the idempotent installer and confirms memory + skill discovery are live.

## What this command does

1. Checks whether `~/.claude/mcp.json` already has the bifrost server entry.
2. If missing, merges it in (idempotent — safe to run multiple times).
3. Prints the `export BIFROST_VK=` reminder if a key was supplied.
4. Guides you to verify the connection.

## One-command onboarding

```bash
# Point BIFROST_URL at your gateway, then run the installer:
export BIFROST_URL=https://<your-gateway-host>/mcp
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js" --key vk_<your-key>

# Or without a key (VK must already be in env):
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js"
```

This single command:
- Merges the bifrost MCP entry into `~/.claude/mcp.json` (idempotent; backs up to `mcp.json.bak`, writes atomically)
- Prints the `export BIFROST_VK=` line for you to add to your shell profile yourself
- Exits cleanly; restart Claude Code to activate

## After install

1. Add `export BIFROST_VK=<your-key>` to `~/.zshrc` or `~/.bashrc`
2. Restart Claude Code
3. Verify by running this command again or typing "set up bifrost"

## Verification checklist

- The gateway's skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) is reachable (MCP loaded)
- Memory injection fires on non-trivial prompts (memory service running on `${BIFROST_MEMORY_URL}`, default `127.0.0.1:52421`)
- SessionStart injects bifrost context at the top of each session

## Troubleshoot

Type **"bifrost not working"** to invoke the `bifrost-debug` skill for a guided diagnosis.
Type **"manually add bifrost mcp"** to invoke `bifrost-mcp-setup` for manual wiring steps.

## Key source

Obtain your gateway URL and VK from your gateway operator.
The key is never stored in any file — it lives only in your shell environment as `BIFROST_VK`.
