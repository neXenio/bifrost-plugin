# Bifrost gateway — session context

You are connected to a **Bifrost MCP gateway**: a unified MCP proxy that routes to
the tools and skill library your gateway is configured to expose.

## Gateway

| Item | Value |
|------|-------|
| MCP server | `bifrost` (loaded from plugin or `~/.claude/mcp.json`) |
| Gateway URL | from `${BIFROST_URL}` env var (defaults to a placeholder until set) |
| Auth | `x-bf-vk` header — value from `${BIFROST_VK}` env var |

## MCP tools available via bifrost

Tools are namespaced `mcp__bifrost__<server>-<tool>`, where `<server>` is each
upstream server your gateway exposes. Common patterns:

| Tool | Purpose |
|------|---------|
| `mcp__bifrost__<skills-server>-skill_search` | Full-text search over the shared skill library (skill server is `skills` by default) |
| `mcp__bifrost__<skills-server>-skill_navigate` | Decision-tree browse when search doesn't find the right skill |
| `mcp__bifrost__<skills-server>-get_skill` | Load full instructions for a chosen skill |
| `mcp__bifrost__<memory-server>-search` | Query past decisions, people, project context |
| `mcp__bifrost__<memory-server>-store` | Save durable facts or decisions for future sessions |
| `mcp__bifrost__<server>-*` | Any other server your gateway routes to (docs, search, issue tracker, analytics, …) |

Run `/mcp` in Claude Code to see exactly which servers and tools your gateway exposes.

## Skill Discovery — MUST do before non-trivial work

**Before implementing, debugging, deploying, writing tests, reviewing a PR, or
setting up infra** — call the gateway's skill-search tool (typically
`mcp__bifrost__<skills-server>-skill_search`) with a short task description. A
matching skill may handle the task entirely or provide a specialized workflow.

Skip only for: single-line edits, file reads/grep, clarifying questions.

## Gateway routing (don't guess — use the gateway)

Route capability requests through whichever MCP servers your gateway exposes:
issue tracker, error tracking, analytics, library/API docs, web search, memory.

## Memory — agent-driven via MCP (PULL)

Memory is **not** auto-injected. You are responsible for using it.

- **Before non-trivial tasks:** call the gateway's memory search tool (typically
  `mcp__bifrost__<memory-server>-search`) with a short query to recall relevant
  past decisions, project facts, or context.
- **After completing significant work:** call the gateway's memory store tool
  (typically `mcp__bifrost__<memory-server>-store`) to save durable facts —
  decisions made, root causes found, conventions learned, gotchas discovered.
  Exclude: transient details, secrets, per-file noise.

## Onboarding / troubleshooting

- `/bifrost-onboard` — first-time setup walkthrough
- `/bifrost-debug` — diagnose MCP / skill-discovery failures
- `/bifrost-mcp-setup` — manual MCP wiring fallback
