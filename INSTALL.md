# Installation guide

## Prerequisites

- Node.js >= 18
- Claude Code (CC) with MCP + plugin support
- Your gateway's `/mcp` endpoint URL (`BIFROST_URL`) and a virtual key (`BIFROST_VK`), from your gateway operator

## Method 1 — CC marketplace (recommended)

```
/plugin marketplace add neXenio/bifrost-plugin
/plugin install bifrost-plugin
```

The plugin ships its own `.mcp.json`, so enabling it registers the `bifrost`
MCP server automatically — no installer needed. Then persist the env vars in
your shell profile and restart Claude Code:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc   # or ~/.bashrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
source ~/.zshrc
```

Run `/bifrost-setup` to verify.

## Method 2 — `claude mcp add` (no plugin, MCP server only)

If you only want the gateway MCP server without the plugin's hooks and skills:

```bash
claude mcp add --scope user --transport http bifrost \
  "https://<your-gateway-host>/mcp" --header "x-bf-vk: ${BIFROST_VK}"
```

The installer script wraps exactly this command (it never edits config files
directly):

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js            # uses the ${BIFROST_VK} runtime template
node bin/install.js --key vk_… # or bake the key into the entry instead
node bin/install.js --dry-run  # print the command without running it
```

Without `--key`, the key is never written to disk — set `BIFROST_VK` in your
shell profile as in Method 1.

## Method 3 — Inside Claude Code

Run:

```
/bifrost-setup
```

It walks through the same `claude mcp add` registration (or, if your gateway
operator has configured an SSO keyapp via `BIFROST_KEYAPP_URL`, offers the
browser-based key provisioning flow). Onboarding only ever runs when you
invoke this command explicitly — the plugin never launches it on its own.

## Verify

After install and restart:

1. Open a new Claude Code session — you should see bifrost context injected at session start.
2. Type: `"implement a new feature"` — expect a skill-discovery hint pointing at the gateway's skill-search tool.
3. If your gateway exposes a skill server, call `mcp__bifrost__<skills-server>-skill_search` with any task description — it should return matches.
4. If your gateway exposes a memory server, call the memory search tool before a task and the memory store tool after — run `/mcp` to see which tools are available.

## What the plugin touches on your machine

- Reads/writes its own cache under `~/.cache/bifrost-plugin/` only.
- Registers the `bifrost` MCP server via its shipped `.mcp.json` (plugin path)
  or via `claude mcp add` (explicit installer/command) — it never edits Claude
  Code config files directly.
- The SessionStart hook contacts your gateway in a detached background worker
  (at most once per hour) to refresh cached recall; the query contains only the
  project directory basename plus a fixed recall phrase. Set `BIFROST_REFRESH=0`
  to disable all session-start-initiated network traffic.

## Uninstall

```bash
# 1. Remove / disable the plugin in Claude Code:
#      /plugin uninstall bifrost-plugin

# 2. If you registered the MCP server via Method 2:
claude mcp remove --scope user bifrost

# 3. Remove 'export BIFROST_URL=...' / 'export BIFROST_VK=...' from ~/.zshrc / ~/.bashrc if you added them.

# 4. Optionally clear the cache:
rm -rf ~/.cache/bifrost-plugin
```

## Troubleshoot

Type **"bifrost not working"** in Claude Code to invoke the `bifrost-debug` skill.
