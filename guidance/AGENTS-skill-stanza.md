## Skill Discovery — check before non-trivial work (MANDATORY)

The `bifrost` MCP gateway may expose a shared skill library and a set of MCP
servers (docs, search, issue tracker, memory, etc.) — whatever your gateway is
configured to route to.

**BEFORE starting any non-trivial task** — implementing a feature, writing a
migration, debugging, reviewing a PR, deploying, setting up infra, writing tests,
or drafting docs — you MUST call the gateway's skill-search tool, typically
**`mcp__plugin_bifrost-plugin_bifrost__<skills-server>-skill_search`** (`mcp__bifrost__…`
with a hand-added server, `mcp__claude_ai_<Name>__…` via the claude.ai connector; the skill server is named
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
  via the gateway's memory MCP tool before non-trivial tasks; save decisions
  after completing significant work)
## Outgoing company communications — final quality pass

Before presenting a final external draft or preparing outgoing company emails,
customer responses, proposals, website copy or social posts, load
`anti-ai-slop-docs-marketing` through the advertised skill catalog and apply a
final quality pass. Use the actual advertised search/navigation and retrieval
schemas; do not assume a gateway host, server prefix or local skill path.
A relevant skill already loaded in this session need not be fetched again.
This requirement also covers short outgoing copy that otherwise qualifies for
skipping general skill discovery.

Preserve facts, names, numbers, links, quotations, legal disclosures and the
intended voice. Improve clarity and remove unsupported or repetitive wording
without inventing claims or strengthening uncertainty. Respect review-only
requests and exact approved copy: report concerns instead of silently rewriting
text that must remain exact. A quality pass does not authorize sending or
publishing; existing approval and destination requirements still apply.

If the skill is unavailable, say so briefly and perform only the checks you can
support; never claim the skill was loaded or applied. This default does not
activate watermark or metadata removal, backend setup, uploads, sending or
publishing. Do not expand it to ordinary internal chat or unrelated code work.
