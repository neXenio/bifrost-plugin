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
MCP server automatically, no installer needed. The install prompt collects
the gateway URL and a virtual key. Leaving the key blank tries OAuth
instead, which needs a client ID from your gateway operator before it works
(see the README). Claude Code uses whatever you enter directly, so no shell
setup is required for the MCP connection itself.

The hooks (memory recall, skill-discovery hints, usage tracking) read the
same two values, so the install prompt covers them as well and nothing else
is needed. Set the env vars only to point the hooks at a different gateway
than the MCP connection uses, then restart Claude Code:

```bash
echo 'export BIFROST_URL=https://bifrost.culture4.life/mcp' >> ~/.zshrc   # or ~/.bashrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
source ~/.zshrc
```

The URL above is the neXenio gateway. Running your own? Point `BIFROST_URL`
at it for the hooks. Nothing else in the plugin is deployment-specific, and
the endpoint-migration notice is retargetable via `BIFROST_LEGACY_HOSTS` /
`BIFROST_CANONICAL_URL` (see README).

Run `/bifrost-setup` to verify.

## Method 1b — Claude Desktop / claude.ai

Claude Desktop has three tabs (Code, Cowork, Chat), and each tab installs
plugins differently. claude.ai on the web uses the same path as Chat and
Cowork.

- **Desktop, Code tab:** click the `+` button next to the prompt box, then
  Plugins, then Add plugin.
- **Desktop, Chat and Cowork tabs, and claude.ai web:** open Customize in the
  left sidebar, then the Plugins tab, then Browse plugins, then Add from a
  repository, pointing at `neXenio/bifrost-plugin`. Plugins added this way
  sync through your claude.ai account, not from `~/.claude`.

Either path prompts for the gateway URL and a virtual key at install time,
the same `userConfig` prompt as the CLI. The gateway URL is prefilled, so the
key is the only thing to supply.

Get the key at [https://bifrost.culture4.life/](https://bifrost.culture4.life/):
sign in with your company account and the page shows your key with a copy
button. The first visit creates it, later visits show the same one. Your
sign-in address has to be on `luca-app.de` or `nexenio.com`, otherwise you
get `403 domain not permitted` after logging in.

Leaving the key blank tries OAuth instead, which needs a pre-registered
client ID from your gateway operator before it completes (see
[Virtual key or OAuth](README.md#virtual-key-or-oauth) in the README).

Hooks and subagents run in the Code and Cowork tabs. On the Chat tab and on
claude.ai web they do not, so skills, slash commands, and the gateway's MCP
tools still work there, while memory auto-injection, skill-discovery hints,
and usage tracking are inactive. See the capability matrix in the README.

## Method 2 — `claude mcp add` (no plugin, MCP server only)

> **Pick one method, not both.** Claude Code keys MCP servers by name within a scope,
> and both methods register a server called `bifrost`. Run both and the two collide:
> the user-scope entry wins, so `mcp__bifrost__*` tools in any directory carrying the
> plugin's `.mcp.json` reach whichever endpoint that entry names, and if the plugin's
> own `${user_config.gateway_url}` was never filled in they disappear entirely. Either
> way `claude mcp list` still shows a connected `bifrost`, so it looks like the gateway
> is down when it is not. SessionStart detects this and says so.
>
> Already in that state? Either run `/plugin configure` so the plugin entry resolves to
> the same endpoint, or `claude mcp remove bifrost -s user` and let the plugin own the
> name.

If you only want the gateway MCP server without the plugin's hooks and skills:

```bash
claude mcp add --scope user --transport http bifrost \
  "https://bifrost.culture4.life/mcp" --header "x-bf-vk: ${BIFROST_VK}"
```

The installer script wraps exactly this command (it never edits config files
directly):

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://bifrost.culture4.life/mcp
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

# 3. Remove 'export BIFROST_URL=...' / 'export BIFROST_VK=...' from ~/.zshrc / ~/.bashrc
#    if you set them for the hooks (Method 1) or for Method 2.

# 4. Optionally clear the cache:
rm -rf ~/.cache/bifrost-plugin
```

## Troubleshoot

Type **"bifrost not working"** in Claude Code to invoke the `bifrost-debug` skill.
