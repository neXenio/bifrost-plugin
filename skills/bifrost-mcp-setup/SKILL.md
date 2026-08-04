---
name: bifrost-mcp-setup
description: "Manually wire a Bifrost MCP server into Claude Code (mcp.json) when the automated installer can't run, or add the Bifrost plugin on Claude Desktop and claude.ai through the Plugins UI. Triggers on 'manually add bifrost mcp', 'edit mcp.json for bifrost', 'installer failed', 'add x-bf-vk header', 'manual bifrost setup', 'mcp.json bifrost', 'bifrost in claude desktop', 'claude_desktop_config'."
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

## Claude Desktop

Desktop has no shell, so `${BIFROST_URL}` and `${BIFROST_VK}` never resolve
there, and it does not read this project's `.mcp.json`. The supported path is
installing the plugin itself, which prompts for the gateway URL, virtual key,
and OAuth client ID at install time and stores them as plugin config. The
bundled `.mcp.json` reads those back as `${user_config.gateway_url}` and so on.

### Install the plugin (preferred)

Desktop Code tab: `+` button next to the prompt box → Plugins → Add plugin.

Desktop Chat and Cowork tabs, and claude.ai: Customize (left sidebar) →
Plugins → Browse plugins → Add from a repository.

Either path prompts for the gateway URL (keep the default unless your operator
gave you a different one), a virtual key (paste the `vk_...` key your operator
issued you), and an OAuth client ID (leave empty unless told otherwise, see
below). Change any of these later with `/plugin configure`.

Signing in with a company account instead of a virtual key does not fully work
yet. With no client ID, Claude's OAuth discovery fails outright. With an
operator-issued client ID it gets as far as a healthy "Needs authentication"
state, but completing login still needs the identity provider to allow the
redirect URI `http://localhost:51789/callback` for that client. Use a virtual
key until your gateway operator confirms OAuth is ready. See `/bifrost-debug`
step 9 for the exact errors and their causes.

### Legacy fallback: local `mcp-remote` proxy

Only for plugin versions before 1.5.0, or installs that cannot use the plugin
at all. Requires Node. Edit
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "npx",
      "args": [
        "mcp-remote", "https://<stable-gateway-host>/mcp",
        "--transport", "http-only",
        "--header", "x-bf-vk:${BIFROST_VK}"
      ],
      "env": { "BIFROST_VK": "vk_<your-key>" }
    }
  }
}
```

No spaces around `:` in the `--header` arg. This file then contains your key —
treat it as a secret (`chmod 600` on macOS/Linux) and never commit it.
Restart Claude Desktop afterwards.

## Troubleshooting

- **401 from bifrost** → `BIFROST_VK` is wrong or not exported. Re-check your shell env.
- **Tool not found after restart** → `claude mcp get bifrost` should show `"type": "http"` (not `"sse"`); re-run Step 2 if the entry is missing.
- **Gateway timeout** → gateway may be offline or `BIFROST_URL` is wrong. Contact the gateway operator.
- **Desktop OAuth errors** (`Incompatible auth server`, `Policy 'Trusted Hosts' rejected`) → run `/bifrost-debug` step 9.

For full diagnosis: `/bifrost-debug`.
