# Bifrost gateway — Engineer Guide

## What is Bifrost?

Bifrost is a unified MCP gateway: a single HTTP endpoint that proxies to your
tooling (issue trackers, error tracking, analytics, docs, search, a memory
service, etc.) and can serve a shared skill library. Every Claude Code session
with this plugin enabled gets:

1. **Skill discovery** — task prompts can trigger an automatic skill search and
   receive matching skill names or a hint to search the library.
2. **Onboarding** — `/bifrost-setup` guides plugin installation and configuration.
   `node scripts/install.js --key vk_…` is the separate manual-registration fallback.
3. **Memory recall** — the prompt hook can search team memory and inject returned
   excerpts. The agent can also recall context and save decisions explicitly through
   the gateway's memory MCP tools. See [prompt privacy](../docs/prompt-privacy.md)
   for automatic-search payloads, filtering limits and the local opt-out.

## Prerequisites

- Node.js 22.x, 24.x or 26.x on PATH, using the latest patch release; other major lines are unsupported. Node.js 26 LTS is recommended.
- Your gateway's `/mcp` endpoint and personal virtual key, entered in plugin configuration
- For manual registration only: `BIFROST_URL` and `BIFROST_VK` in the launching environment
- Claude Code with the bifrost-plugin installed

## Environment overrides (optional for plugin installs)

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Gateway `/mcp` endpoint | `https://your-bifrost-gateway.example/mcp` (placeholder) |
| `BIFROST_VK` | Virtual key for the `x-bf-vk` auth header | (unset — required) |
| `BIFROST_SKILLS_SERVER` | Name of the gateway's skill server | `skills` |

## Onboarding (first time)

Use `/bifrost-setup` in Claude Code for the plugin path. No separate registration
is needed. If you cannot install the plugin, use this fallback from the repository:

```bash
# From the plugin root:
export BIFROST_URL=https://<your-gateway-host>/mcp
node scripts/install.js --key vk_<your-key>

```

The installer:
1. Registers the bifrost MCP server via `claude mcp add --scope user`. Existing
   entries are refused by Claude Code 2.1.322, not replaced. Inspect the existing
   entry before deliberately changing it; the installer does not remove it.
2. Without `--key`, stores the `${BIFROST_VK}` runtime template — you must set
   `export BIFROST_VK=…` in `~/.zshrc` (or `~/.bashrc`) yourself for the key
   to resolve.
3. Tells you to restart CC; then verify `/mcp` and an authorized read-only tool call.

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

## Claude Desktop

Desktop Code follows the Claude Code plugin path. Chat ignores MCP URLs containing
user-config references, while Cowork skips entries referencing options without
defaults and does not prompt for values. This plugin's virtual key has no default:
installing its skills there does not establish a connection. Chat does not run hooks.
Use a separately verified connector on those surfaces; see the dated
[support matrix](../README.md#registration-and-connection-modes).

## Hooks

The plugin registers six Claude Code events across five hook scripts:

| Event | Hook file | What it does |
|-------|-----------|--------------|
| `SessionStart` | `session-start.cjs` | Injects `guidance/bifrost-context.md` (~400 tokens) as session context |
| `UserPromptSubmit` | `prompt-submit.cjs` | Automatic skill/memory searches and context, with a skill-search hint fallback; requires a gateway credential and a query that passes the local privacy checks |
| `PreToolUse` | `route-hint.cjs` | On Bash/WebFetch calls, suggests a matching advertised gateway server once per server per session |
| `Stop` | `session-reflect.cjs` (async) | Asks about memory candidates from the third turn of a session, then every eight |
| `PostToolUse` | `usage.cjs` (async) | Records which capability classes were used, for successful bifrost tool calls |
| `PostToolUseFailure` | `usage.cjs` (async) | Same usage recording, for failed bifrost tool calls |

`PostToolUse` and `PostToolUseFailure` both match only gateway tool calls, in all
three namespaces: `mcp__bifrost__` (hand-added server), `mcp__plugin_<plugin>_bifrost__`
(this plugin) and `mcp__claude_ai_<Name>__` for a claude.ai connector whose name
contains "bifrost".

All hooks are silent-fail: any error results in `exit 0` with no output. A
crashed hook never blocks your session.

## Memory — automatic recall and explicit MCP calls

The prompt hook can send up to 600 normalized prompt characters to enabled skill
and memory searches, then inject returned context. Likely secrets cause the whole
query to be withheld, but pattern checks cannot detect every sensitive value.
Set `BIFROST_PROMPT_RECALL=0` in Claude Code's environment to disable both automatic
searches regardless of server policy. See [prompt privacy](../docs/prompt-privacy.md)
for scope and limits. Explicit agent tool calls remain available.

**How to use it:**

1. **Before non-trivial tasks** — call the gateway's memory search tool (typically
   `<prefix><memory-server>-search`) with a short query to recall relevant
   past decisions, project facts, or context.
2. **After completing significant work** — call the gateway's memory store tool
   (typically `<prefix><memory-server>-store`) to save durable facts.
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
| Desktop: OAuth fails before login (`Incompatible auth server` or `Trusted Hosts` errors) | Gateway or identity provider does not support Claude self-registering as an OAuth client | Use a virtual key or `auto_login`; `/bifrost-debug` step 9 |
| Desktop: `no_virtual_key` after a successful login | Identity not yet in the gateway's VK map | Ask the gateway operator to map your email to a virtual key |

## Gateway routing reference

Tools are namespaced `<prefix><server>-<tool>`, where the prefix depends on how the
gateway is connected: `mcp__plugin_bifrost-plugin_bifrost__` for this plugin's own
server, `mcp__bifrost__` for a hand-added `bifrost` server (which hides the plugin's),
and `mcp__claude_ai_<Name>__` for the claude.ai org connector (e.g.
`mcp__claude_ai_luca_Bifrost__`; spaces and dots become `_`). The session context
names the one that applies. Which servers exist depends
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
