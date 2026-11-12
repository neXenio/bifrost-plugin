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

## Step 2 — Install and configure the Claude Code plugin

Run `/plugin marketplace add neXenio/bifrost-plugin`, then `/plugin install
bifrost-plugin`. Enter the gateway URL and personal virtual key in the plugin
configuration. `/bifrost-setup` guides this plugin path; it is not an alias for
the fallback installer. No extra MCP registration or shell exports are needed.

For a machine that cannot install the plugin, use `bifrost-mcp-setup` instead.
Its installer calls `claude mcp add --scope user`; an existing entry is refused,
not replaced. Without `--key`, the registration uses a runtime environment
placeholder; the user must provide `BIFROST_VK` in the launching environment.

## Step 3 — Load the installed copy

Run `/reload-plugins` where supported, or start a new Claude Code session. A
changed MCP configuration reconnects on reload; unchanged configurations keep
their connection. Start a new session to verify SessionStart context. Updating a
repository does not update an installed copy or an organization mirror.
[Reload reference](https://code.claude.com/docs/en/plugins/components#server-names-tool-names-and-reloads).

## Step 4 — Smoke check

Run these checks to confirm everything is live:

1. **MCP loaded:** type `/mcp` — `bifrost` should appear in the server list.
2. **Skill search works:** if your gateway exposes a skill server, call
   `<prefix><skills-server>-skill_search` with `"test connection"` (`<prefix>` is `mcp__plugin_bifrost-plugin_bifrost__` from the plugin, `mcp__claude_ai_luca_Bifrost__` from the claude.ai connector, `mcp__bifrost__` from a hand-added server) — should return results.
3. **Memory tools:** if your gateway exposes a memory server, call its search tool
   (`<prefix><memory-server>-search`) with a short query — should return results or an empty list.
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

Desktop Code uses the Claude Code configuration path above. Do not apply the
same instructions to Chat or Cowork: Chat ignores MCP URLs containing user-config
references, while Cowork skips entries referencing options without defaults and
does not prompt for them. This plugin's virtual key has no default.

Skills may load while the MCP connection is absent. An operator must provide a
compatible fixed-URL connector and supported authentication before claiming
Chat/Cowork connectivity. Chat does not run hooks. Cowork host support for hooks
does not prove this plugin has connected there. See the dated
[support matrix](../../README.md#registration-and-connection-modes) and
[platform documentation](https://claude.com/docs/plugins/platform-support).

## Troubleshooting

If anything fails, run `/bifrost-debug` for guided diagnosis.
For manual MCP wiring, run `/bifrost-mcp-setup`.
