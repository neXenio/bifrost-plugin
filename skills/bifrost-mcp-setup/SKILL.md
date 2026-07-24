---
name: bifrost-mcp-setup
description: "Manually wire a Bifrost MCP server into Claude Code when the automated installer can't run. Triggers on 'manually add bifrost mcp', 'installer failed', 'add x-bf-vk header', 'manual bifrost setup', 'register bifrost mcp'."
---

# Manual Bifrost MCP Setup

Use this when the automated installer (`node bin/install.js` / `/bifrost-setup`)
can't run (no internet, policy restriction, etc.).

Note: if the plugin itself is installed and enabled, none of this is needed —
the plugin's shipped `.mcp.json` registers the `bifrost` server automatically.
This skill is for wiring the MCP server WITHOUT the plugin.

## Step 1 — Set your gateway URL and virtual key

```bash
# Add to ~/.zshrc or ~/.bashrc (replace with your real values):
export BIFROST_URL=https://<your-gateway-host>/mcp
export BIFROST_VK=vk_<your-key>
source ~/.zshrc   # or ~/.bashrc
```

Never commit the VK. It belongs in your shell env only.

## Step 2 — Register the server with the Claude Code CLI

```bash
claude mcp add --scope user --transport http bifrost \
  "${BIFROST_URL}" --header 'x-bf-vk: ${BIFROST_VK}'
```

The single-quoted `${BIFROST_VK}` is stored as a runtime template — Claude Code
resolves it from your shell env on every launch, so the key itself is never
written to disk. Re-running the command replaces the same entry (idempotent).

## Step 3 — Restart Claude Code

MCP registration changes take effect only after a CC restart.

## Step 4 — Verify

```bash
# Confirm the entry is present:
claude mcp get bifrost

# Confirm env vars are set:
echo "URL: ${BIFROST_URL:-NOT SET}"
echo "VK: ${BIFROST_VK:+set (${#BIFROST_VK} chars)}${BIFROST_VK:-NOT SET}"
```

If your gateway exposes a skill server, then inside Claude Code call
`mcp__bifrost__<skills-server>-skill_search` with `"test"` — if it returns
results, the gateway is live.

## Uninstall

```bash
claude mcp remove --scope user bifrost
```

## Troubleshooting

- **401 from bifrost** → `BIFROST_VK` is wrong or not exported. Re-check your shell env.
- **Tool not found after restart** → `claude mcp get bifrost` should show `"type": "http"` (not `"sse"`); re-run Step 2 if the entry is missing.
- **Gateway timeout** → gateway may be offline or `BIFROST_URL` is wrong. Contact the gateway operator.

For full diagnosis: `/bifrost-debug`.
