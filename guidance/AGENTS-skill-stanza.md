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
- Past decisions, people, project facts → your memory server (also auto-injected
  per prompt by this plugin; query it for more)
