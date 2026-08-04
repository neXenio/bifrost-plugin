---
description: Set up the Bifrost MCP gateway. Install the plugin and verify memory + skill discovery are live.
---

# /bifrost-setup

Set up a Bifrost MCP gateway and confirm memory and skill discovery are live.
This command is the ONLY place onboarding runs. The plugin never launches
setup on its own.

## Primary path: install the plugin

CLI: `/plugin marketplace add neXenio/bifrost-plugin` then `/plugin install
bifrost-plugin`. On Desktop and claude.ai, see the per-surface install steps
in the `bifrost-onboard` skill.

Installing prompts for the plugin's three config values:

- **Gateway URL** (`gateway_url`): defaults to the shared gateway.
- **Virtual key** (`virtual_key`, optional): paste the `vk_...` key your
  gateway operator issued you. Leave it blank to sign in with your company
  account through OAuth instead.
- **OAuth client ID** (`oauth_client_id`, optional): only needed if your
  identity provider does not let Claude register itself. Ask your gateway
  operator for it.

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
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js" --key vk_<your-key>

# Or without a key (VK must already be in env):
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js"
```

This wraps exactly one command, `claude mcp add --scope user --transport http
bifrost "$BIFROST_URL" --header "x-bf-vk: …"`, and never edits config files
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
