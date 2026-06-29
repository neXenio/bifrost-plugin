---
name: bifrost-mcp-setup
description: "Manually wire a Bifrost MCP server into Claude Code when the automated installer can't run. Triggers on 'manually add bifrost mcp', 'edit mcp.json for bifrost', 'installer failed', 'add x-bf-vk header', 'manual bifrost setup', 'mcp.json bifrost'."
---

# Manual Bifrost MCP Setup

Use this when the automated installer (`node bin/install.js` / `/bifrost-setup`)
can't run (no internet, policy restriction, etc.).

## Step 1 — Set your gateway URL and virtual key

```bash
# Add to ~/.zshrc or ~/.bashrc (replace with your real values):
export BIFROST_URL=https://<your-gateway-host>/mcp
export BIFROST_VK=vk_<your-key>
source ~/.zshrc   # or ~/.bashrc
```

Never commit the VK. It belongs in your shell env only.

## Step 2 — Edit ~/.claude/mcp.json

Open `~/.claude/mcp.json` (create it if it doesn't exist) and merge in the
bifrost server block. The `${BIFROST_URL}` and `${BIFROST_VK}` placeholders are
resolved at runtime from your shell env:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "http",
      "url": "${BIFROST_URL}",
      "headers": { "x-bf-vk": "${BIFROST_VK}" }
    }
  }
}
```

If the file already has other servers under `mcpServers`, add `"bifrost": { … }`
alongside them — do not overwrite the whole file.

Quick one-liner to add it (uses node for safe JSON merge):

```bash
node -e "
const fs = require('fs'), os = require('os');
const f = os.homedir() + '/.claude/mcp.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
if (cfg.mcpServers.bifrost) { console.log('bifrost already present — no change'); process.exit(0); }
cfg.mcpServers.bifrost = {
  type: 'http',
  url: '\${BIFROST_URL}',
  headers: { 'x-bf-vk': '\${BIFROST_VK}' }
};
fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
console.log('bifrost added to', f);
"
```

## Step 3 — Restart Claude Code

Changes to `~/.claude/mcp.json` take effect only after a CC restart.

## Step 4 — Verify

```bash
# Confirm the entry is present:
node -e "const m=require(require('os').homedir()+'/.claude/mcp.json'); console.log(JSON.stringify(m.mcpServers.bifrost, null, 2))"

# Confirm env vars are set:
echo "URL: ${BIFROST_URL:-NOT SET}"
echo "VK: ${BIFROST_VK:+set (${#BIFROST_VK} chars)}${BIFROST_VK:-NOT SET}"
```

If your gateway exposes a skill server, then inside Claude Code call
`mcp__bifrost__<skills-server>-skill_search` with `"test"` — if it returns
results, the gateway is live.

## Troubleshooting

- **401 from bifrost** → `BIFROST_VK` is wrong or not exported. Re-check your shell env.
- **Tool not found after restart** → confirm `~/.claude/mcp.json` has `"type":"http"` (not `"sse"`).
- **Gateway timeout** → gateway may be offline or `BIFROST_URL` is wrong. Contact the gateway operator.

For full diagnosis: `/bifrost-debug`.
