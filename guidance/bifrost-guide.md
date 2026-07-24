# Bifrost gateway — Engineer Guide

## What is Bifrost?

Bifrost is a unified MCP gateway: a single HTTP endpoint that proxies to your
tooling (issue trackers, error tracking, analytics, docs, search, a memory
service, etc.) and can serve a shared skill library. Every Claude Code session
with this plugin enabled gets:

1. **Skill discovery** — non-trivial prompts receive a hint to call the gateway's
   skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) before starting,
   so existing workflows are reused.
2. **One-command onboarding** — `node bin/install.js --key vk_…` (or the
   `/bifrost-setup` slash command) wires the MCP entry in seconds.
3. **Agent-driven memory** — the agent recalls relevant context before non-trivial
   tasks and saves decisions after significant work, using the gateway's memory MCP
   tools directly. No automatic injection; the agent controls when to pull and push.

## Prerequisites

- Node.js 18+ on PATH
- `BIFROST_URL` env var set to your gateway's `/mcp` endpoint
- `BIFROST_VK` env var set to your virtual key (issued by your gateway operator)
- Claude Code with the bifrost-plugin installed

## Configuration (env vars)

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Gateway `/mcp` endpoint | `https://your-bifrost-gateway.example/mcp` (placeholder) |
| `BIFROST_VK` | Virtual key for the `x-bf-vk` auth header | (unset — required) |
| `BIFROST_SKILLS_SERVER` | Name of the gateway's skill server | `skills` |

## Onboarding (first time)

```bash
# From the plugin root:
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js --key vk_<your-key>

# Or use the slash command inside Claude Code:
/bifrost-setup
```

The installer:
1. Registers the bifrost MCP server via `claude mcp add --scope user` (idempotent —
   re-running replaces the same entry; it never edits config files directly).
2. Without `--key`, stores the `${BIFROST_VK}` runtime template — you must set
   `export BIFROST_VK=…` in `~/.zshrc` (or `~/.bashrc`) yourself for the key
   to resolve.
3. Tells you to restart CC, after which the gateway and skill-search tools are callable.

To append the skill-discovery MUST-stanza to your `~/.claude/CLAUDE.md`, the
`bifrost-onboard` skill offers to do this idempotently (skips if the
`## Skill Discovery` heading is already present).

## Manual MCP wiring (fallback)

If the installer can't run, register the server yourself with Claude Code's CLI:

```bash
claude mcp add --scope user --transport http bifrost \
  "https://<your-gateway-host>/mcp" --header "x-bf-vk: ${BIFROST_VK}"
```

(Plugin installs don't need this at all — the shipped `.mcp.json` self-wires
when the plugin is enabled.) Set `BIFROST_URL` and `BIFROST_VK` in your shell,
restart Claude Code, and confirm the `bifrost` server appears in `/mcp`.

## Hooks

The plugin registers two Claude Code hooks:

| Event | Hook file | What it does |
|-------|-----------|--------------|
| `SessionStart` | `session-start.cjs` | Injects `guidance/bifrost-context.md` (~400 tokens) as session context |
| `UserPromptSubmit` | `prompt-submit.cjs` | Skill-discovery hint for task-verb prompts (suppressed when `BIFROST_VK` unset) |

All hooks are silent-fail: any error results in `exit 0` with no output. A
crashed hook never blocks your session.

## Memory — agent-driven via the gateway MCP

Memory is pull-only and agent-driven. There is no automatic per-prompt injection.

**How to use it:**

1. **Before non-trivial tasks** — call the gateway's memory search tool (typically
   `mcp__bifrost__<memory-server>-search`) with a short query to recall relevant
   past decisions, project facts, or context.
2. **After completing significant work** — call the gateway's memory store tool
   (typically `mcp__bifrost__<memory-server>-store`) to save durable facts.
   Include: decisions made, root causes found, conventions learned, gotchas
   discovered. Exclude: transient details, secrets, per-file noise.

Run `/mcp` to confirm which memory tools your gateway exposes and their exact names.

If the gateway exposes no memory server, memory calls silently no-op — the gateway
and skill discovery still work.

## Troubleshooting

Use `/bifrost-debug` inside Claude Code for guided diagnosis. Quick checklist:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| 401 / 403 from bifrost | `BIFROST_VK` missing or wrong | Re-run setup or set `export BIFROST_VK=vk_<your-key>` |
| No skills found | bifrost MCP not loaded, or no skill server | Check `claude mcp get bifrost` / `/mcp`; run `/bifrost-mcp-setup` |
| Hook not firing | Plugin not installed/enabled | Re-install / re-enable via `/plugin`; restart CC (hooks ship inside the plugin, not `settings.json`) |

## Gateway routing reference

Tools are namespaced `mcp__bifrost__<server>-<tool>`. Which servers exist depends
entirely on how your gateway is configured. Run `/mcp` to list them. Typical roles:

| Need | Server role | Notes |
|------|-------------|-------|
| Issue / ticket ops | issue tracker | create, read, search, comment |
| Production errors | error tracking | triage, root-cause |
| Analytics | analytics / database | queries against your data |
| Library docs | docs | always prefer over training data for SDK/API docs |
| Web search | search | current information outside the codebase |
| Past decisions / people | memory | recall before tasks; save after significant work |
| Skills | skills | `skill_search`, `skill_navigate`, `get_skill` |
