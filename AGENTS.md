# bifrost-plugin — AGENTS.md

## Skill Discovery — check before non-trivial work (MANDATORY)

The `bifrost` MCP gateway may expose a shared skill library and a set of MCP
servers (docs, search, issue tracker, memory, etc.) — whatever your gateway is
configured to route to.

**BEFORE starting any non-trivial task** — implementing a feature, writing a
migration, debugging, reviewing a PR, deploying, setting up infra, writing tests,
or drafting docs — you MUST call the gateway's skill-search tool, typically
**`mcp__bifrost__<skills-server>-skill_search`** (the skill server is named
`skills` by default; set `BIFROST_SKILLS_SERVER` if your gateway names it
differently), with a short description of the task. It returns the top matching
skills (a skill may handle the task entirely or give a specialized workflow). If
search doesn't surface the right one, browse with the corresponding
`skill_navigate` tool (decision tree), then load the chosen skill's full
instructions with `get_skill` before proceeding.

**Skip skill discovery for:** single-line edits with a known target, file
reads / grep, clarifying questions, or tasks the user has scoped to one file.

### Gateway routing (use bifrost, don't ask the user / don't guess)
Route capability requests through whichever MCP servers your gateway exposes, for
example:
- Issue / ticket status → your issue-tracker server
- Production errors / stacktraces → your error-tracking server
- Analytics / database queries → your analytics server
- Up-to-date library/API docs → your docs server (NOT training memory)
- Web search → your web-search server
- Past decisions, people, project facts → your memory server (query directly
  via the gateway's memory MCP tool — see Memory section below)

---

## Memory — agent-driven via the gateway MCP

Memory is accessed through the gateway's memory MCP server. There is no
automatic HTTP injection — memory recall and save are your responsibility as
the agent.

**Before non-trivial tasks:** call the gateway's memory search tool (typically
`mcp__bifrost__<memory-server>-search`) with a short query to recall relevant
past decisions, project facts, or context (e.g. `k=5`).

**After completing significant work:** save durable facts or decisions with the
gateway's memory store tool (typically `mcp__bifrost__<memory-server>-store` or
the equivalent write tool your gateway exposes). Include: decisions made, root
causes found, conventions learned, gotchas discovered. Exclude: transient
details, secrets, per-file noise.

Run `/mcp` to confirm which memory tools your gateway exposes and their exact
tool names.

---

## Plugin file ownership

This repo is split into two concerns with clear boundaries.

### Manifests + MCP + Installer
Owns: `.claude-plugin/`, `.mcp.json`, `bin/`, `commands/`, `.gitignore`, `README.md`

### Hooks + Skills + Guidance
Owns: `hooks/`, `skills/`, `guidance/`, `AGENTS.md`

**Cross-cutting rules:**
- Do **not** declare `hooks/hooks.json` in `plugin.json` — CC auto-loads it; manifest `hooks` is only for *additional* hook files. Never edit hook bodies for naming.
- Hooks reference the MCP server only by name (`bifrost`, skill tool prefix `<skills-server>-`) — never edit `.mcp.json`.

---

## Hook silent-fail contract

Every hook in `hooks/` MUST:
- Wrap the entire body in `try/catch` with `catch: process.exit(0)`
- Never write stack traces or error messages to stderr in a way that surfaces to the user
- Exit 0 on every code path — a non-zero exit blocks the CC session
