# Installation guide

## Prerequisites

- Node.js >= 18
- Claude Code (CC) with MCP + plugin support
- Your gateway's `/mcp` endpoint URL (`BIFROST_URL`) and a virtual key (`BIFROST_VK`), from your gateway operator

## Method 1 — Run the installer (recommended)

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js --key vk_<your-key>
```

The installer merges the bifrost MCP entry into `~/.claude/mcp.json` (idempotent;
backs up to `mcp.json.bak`, writes atomically) and prints an `export BIFROST_VK=…`
line. It does NOT modify your shell profile — persist the env vars yourself:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc   # or ~/.bashrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
source ~/.zshrc
```

Restart Claude Code. The bifrost MCP server is now active.

## Method 2 — Inside Claude Code

After the plugin is installed, run:

```
/bifrost-setup
```

It runs the same installer. Then persist `export BIFROST_URL=…` and
`export BIFROST_VK=vk_<your-key>` in your shell profile and restart Claude Code.

## Method 3 — CC marketplace (once hosted)

```
/plugin marketplace add neXenio/bifrost-plugin
/plugin install bifrost-plugin
```

Then run `/bifrost-setup` to complete setup.

## Method 4 — Manual MCP wiring

If all automated methods fail, add this block to `~/.claude/mcp.json` by hand.
The placeholders resolve at runtime from your shell env:

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

Set `BIFROST_URL` and `BIFROST_VK` in your shell and restart Claude Code.

Type **"manually add bifrost mcp"** in Claude Code for the `bifrost-mcp-setup` guided walkthrough.

## Verify

After install and restart:

1. Open a new Claude Code session — you should see bifrost context injected at session start.
2. Type: `"implement a new feature"` — expect a memory block (if a memory service is running) and a skill-discovery hint.
3. If your gateway exposes a skill server, call `mcp__bifrost__<skills-server>-skill_search` with any task description — it should return matches.

## Idempotency

Running the installer twice is safe. The second run detects the existing entry and exits without changes:

```
[bifrost-plugin] Already configured — no changes made.
```

If `~/.claude/mcp.json` is malformed JSON, the installer ABORTS with a clear
error rather than overwriting it. Existing files are backed up to `mcp.json.bak`
before any write.

## Uninstall

```bash
# 1. Remove / disable the plugin in Claude Code via /plugin (uninstall bifrost-plugin),
#    or remove its directory under ~/.claude/plugins.

# 2. Drop the bifrost entry from ~/.claude/mcp.json:
node -e "
const fs=require('fs'), os=require('os');
const f=os.homedir()+'/.claude/mcp.json';
try {
  const c=JSON.parse(fs.readFileSync(f,'utf8'));
  if (c.mcpServers) delete c.mcpServers.bifrost;
  fs.writeFileSync(f, JSON.stringify(c,null,2)+'\n');
  console.log('removed bifrost from', f);
} catch (e) { console.error('skip:', e.message); }
"

# 3. Clean the local cache:
rm -rf ~/.cache/bifrost-plugin/

# 4. Remove 'export BIFROST_URL=...' / 'export BIFROST_VK=...' from ~/.zshrc / ~/.bashrc if you added them.
```

## Troubleshoot

Type **"bifrost not working"** in Claude Code to invoke the `bifrost-debug` skill.
