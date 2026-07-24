---
name: bifrost-onboard
description: "Onboard to a Bifrost MCP gateway in Claude Code — run the one-command setup, verify the MCP connects, and confirm memory + skill discovery are live. Triggers on 'set up bifrost', 'onboard me to bifrost', 'install bifrost gateway', 'first-run setup', 'bifrost setup'."
---

# Bifrost Onboarding

Walk through full Bifrost setup in Claude Code (steps 1–5), then optionally
Claude Desktop (step 6).

## Step 1 — Get your gateway URL and virtual key

Ask your gateway operator for two values:
- The gateway `/mcp` endpoint URL → `BIFROST_URL`
- Your personal virtual key (`vk_…`) → `BIFROST_VK`

## Step 2 — Run the installer

From the plugin root (or use the slash command — see below):

```bash
export BIFROST_URL=https://<your-gateway-host>/mcp
node "${CLAUDE_PLUGIN_ROOT}/bin/install.js" --key vk_<your-key>
```

The installer:
- Registers the bifrost MCP server via `claude mcp add --scope user` (idempotent — re-running replaces the same entry; it never edits config files directly).
- Without `--key`, stores the `${BIFROST_VK}` runtime template. It does NOT modify your shell profile — you must add `export BIFROST_VK=…` to `~/.zshrc` (or `~/.bashrc`) yourself for the key to persist across sessions.

Or run the slash command from inside Claude Code (same installer):

```
/bifrost-setup
```

## Step 3 — Persist the env vars, then restart Claude Code

Add the export lines to your shell profile so they survive new shells:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc   # or ~/.bashrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
source ~/.zshrc
```

Then restart CC so the MCP server and hooks are loaded.

> macOS note: Claude Code launched from the Dock or Spotlight does NOT inherit
> `~/.zshrc` exports. Launch CC from a terminal (`open` from a shell, or run the
> `claude` CLI), or set the env vars via a launchd plist, otherwise the gateway
> sees no key.

## Step 4 — Smoke check

Run these checks to confirm everything is live:

1. **MCP loaded:** type `/mcp` — `bifrost` should appear in the server list.
2. **Skill search works:** if your gateway exposes a skill server, call
   `mcp__bifrost__<skills-server>-skill_search` with `"test connection"` — should return results.
3. **Memory tools:** if your gateway exposes a memory server, call its search tool
   (`mcp__bifrost__<memory-server>-search`) with a short query — should return results or an empty list.
4. **Session context:** open a new session — the bifrost context block should appear at the top.

## Step 5 — Add the skill-discovery MUST-stanza (recommended)

Offer to append the stanza from `guidance/AGENTS-skill-stanza.md` to the user's
`~/.claude/CLAUDE.md`. Check first — skip if `## Skill Discovery` heading is
already present (idempotent).

```bash
grep -q "## Skill Discovery" ~/.claude/CLAUDE.md \
  || cat "${CLAUDE_PLUGIN_ROOT}/guidance/AGENTS-skill-stanza.md" >> ~/.claude/CLAUDE.md
```

## Step 6 — Claude Desktop (optional)

Ask whether the user also wants the gateway in Claude Desktop. If yes:

**Preferred — zero-config OAuth Connect:**

1. Claude Desktop → **Settings → Connectors → Add custom connector**.
2. Paste the gateway URL: `https://<stable-gateway-host>/mcp` (must be the
   stable domain the operator gave you — not an ephemeral tunnel URL).
3. Click Connect → a browser opens the company Keycloak login → sign in and
   consent. Desktop registers itself automatically (DCR + PKCE).
4. Verify: the connector shows connected and gateway tools appear in Desktop.

If login succeeds but requests fail with `no_virtual_key`, the operator has
not mapped your identity to a virtual key yet — ask them to add you.
If the connector cannot register a client, enter the operator-provided client
ID under **Advanced settings → OAuth Client ID**.

**Fallback — local proxy** (only if the OAuth bridge is not deployed): add an
`mcp-remote` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`
(see README → Authentication modes for the exact snippet; requires Node, and the
file then holds your VK — treat it as a secret).

## Troubleshooting

If anything fails, run `/bifrost-debug` for guided diagnosis.
For manual MCP wiring, run `/bifrost-mcp-setup`.
