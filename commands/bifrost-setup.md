---
description: Set up the Bifrost MCP gateway. Install the plugin and verify memory + skill discovery are live.
---

# /bifrost-setup

Set up a Bifrost MCP gateway and confirm memory and skill discovery are live.
This command is where onboarding runs. The plugin only launches sign-in on
its own when the opt-in `auto_login` option is on (see below).

## Primary path: install the plugin

CLI: `/plugin marketplace add neXenio/bifrost-plugin` then `/plugin install
bifrost-plugin`. On Desktop and claude.ai, see the per-surface install steps
in the `bifrost-onboard` skill.

Installing prompts for the plugin's config values:

- **Gateway URL** (`gateway_url`): defaults to the shared gateway.
- **Virtual key** (`virtual_key`, optional): paste the `vk_...` key your
  gateway operator issued you. Leave it blank to use auto-login instead.
- **Sign in automatically** (`auto_login`, default off): when no key is set,
  the first interactive session opens your browser for company sign-in and
  caches the key it gets back in `~/.cache/bifrost-plugin/vk`. Afterwards
  restart Claude Code, or in a running session run `/mcp`, pick `bifrost` and
  choose Reconnect (not Authenticate). `BIFROST_AUTO_LOGIN=1` does the same
  from the shell. If the key was rotated or revoked, the plugin drops the
  cached copy on the next 401 and signs in again; to force that by hand,
  `rm ~/.cache/bifrost-plugin/vk`.
- **Key page URL** (`keyapp_url`, optional): where sign-in fetches the key.
  Empty means the gateway's own host.
- **Clean up older Bifrost setups** (`migrate_legacy`, default off): once a
  day, moves the key of a hand-added `bifrost` server for this gateway into the
  plugin and removes that server, which otherwise hides the plugin's own.

The bundled `.mcp.json` reads these back as `${user_config.gateway_url}` and so
on, so no separate registration step is needed. Change any value later with
`/plugin configure`, no reinstall required.

## What this command does

1. Checks whether the plugin is installed and enabled (`/plugin`).
2. If not, walks you through install and the config prompts above.
3. Guides you to verify the connection.

## Env vars: override for the hook layer only

`BIFROST_URL` and `BIFROST_VK`, if both set in your shell, override the
plugin's configured gateway URL and virtual key for the hook layer only
(`session-start.cjs`, `prompt-submit.cjs`, `session-reflect.cjs`,
`usage.cjs`). Use this to point hooks at a different gateway than the one
configured in the plugin, or when running the CLI without a plugin install at
all. The MCP connection itself always uses the plugin's config when the
plugin is installed; these env vars do not change it.

If you are not using the plugin at all, you can still register the server
directly with the Claude Code CLI:

```bash
export BIFROST_URL=https://<your-gateway-host>/mcp
node "${CLAUDE_PLUGIN_ROOT}/scripts/install.js" --key vk_<your-key>

# Or without a key (VK must already be in env):
node "${CLAUDE_PLUGIN_ROOT}/scripts/install.js"
```

This wraps exactly one command, `claude mcp add --scope user --transport http
bifrost "$BIFROST_URL" --header "x-bf-vk: …"`, and never edits config files
itself. Without `--key`, the `${BIFROST_VK}` runtime template is stored and the
key stays only in your shell environment.

If your gateway has an SSO keyapp (`BIFROST_KEYAPP_URL` or the `keyapp_url`
option), you can instead run the browser-based sign-in flow explicitly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/auto-setup.cjs"
```

It opens the keyapp in your browser, receives your key on a loopback-only,
nonce-gated listener, and caches it for the plugin's `bifrost` server. Then
restart Claude Code, or in a running session run `/mcp`, pick `bifrost` and
choose Reconnect (not Authenticate).

## After install

1. Restart Claude Code, or the Desktop app.
2. Verify by running this command again or typing "set up bifrost".

## Verification checklist

- `/plugin` (or `claude mcp list` / `/mcp` on the CLI) shows the `bifrost` server
- The gateway's skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) is reachable (MCP loaded)
- SessionStart injects bifrost context at the top of each session (CLI and Desktop Code/Cowork only)
- Memory tools (if your gateway exposes a memory server) are callable via `mcp__bifrost__<memory-server>-search`

## Troubleshoot

Type **"bifrost not working"** to invoke the `bifrost-debug` skill for a guided diagnosis.
Type **"manually add bifrost mcp"** to invoke `bifrost-mcp-setup` for manual wiring steps.

## Key source

Obtain your gateway URL and VK from your gateway operator, or leave the key
blank at install to sign in with your company account instead. The plugin
marks the virtual key field sensitive, so Claude Code keeps it out of plain
config files. On the CLI-only path, without `--key`, the key is never written
to any file. It lives only in your shell environment as `BIFROST_VK`.
