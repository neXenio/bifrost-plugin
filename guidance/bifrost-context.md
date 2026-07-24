# Bifrost gateway — session context

You are connected to a **Bifrost MCP gateway**: a unified MCP proxy that routes to
the tools, skill library, and memory your gateway exposes.

| Item | Value |
|------|-------|
| MCP server | `bifrost` (from the plugin's `.mcp.json`, or user-scope via `claude mcp add`) |
| Gateway URL | `${BIFROST_URL}` |
| Auth | `x-bf-vk` header from `${BIFROST_VK}` |

## Two ways tools are exposed — this matters

Run `/mcp` to see what loaded. A gateway exposes upstream servers in one of two
modes, and **the same gateway usually mixes both**:

1. **Flat tools** — callable directly, namespaced `mcp__bifrost__<server>-<tool>`
   (e.g. `mcp__bifrost__skills-skill_search`).
2. **Code-mode** — most servers are *not* flat tools. They are reached through the
   meta-tool **`executeToolCode`**, which runs a short Starlark/Python snippet:

   ```
   result = <server>.<tool>(param="value")
   ```

   Discover what code-mode offers with `listToolFiles` (lists `servers/<server>/<tool>.pyi`),
   `readToolFile` (confirm a tool's parameters), and `getToolDocs` (full docs).
   Starlark note: top-level `for`/`if` must live inside a `def`; assign the value
   you want returned to `result`.

If a `mcp__bifrost__<server>-<tool>` tool does not exist, the capability is almost
certainly code-mode — do **not** give up; use `executeToolCode`.

## Skill discovery — do this before non-trivial work

**Before implementing, debugging, deploying, writing tests, reviewing, or setting
up infra**, search the skill library. A match may handle the task outright or give
a specialized procedure. The SessionStart injection shows the exact invocation and
a live sample of the navigator domains for *your* gateway. Typical names:

- `skill_search(query="<task>", k=5)` — search by intent.
- `skill_navigate(node="<id>")` — browse the decision tree (omit `node` for root).
- `get_skill(name="<skill>")` — load full instructions before following them.

Skip only for single-line edits, file reads/grep, and clarifying questions.

## Memory — recall before, store after (agent-driven)

Memory is **not** silently auto-injected (the SessionStart hook primes a few
salient facts, nothing more). You are responsible for using it during the session:

- **Before non-trivial tasks:** `memory_search(query="<short query>", k=6)` to
  recall past decisions, root causes, conventions, people, and project context.
- **After significant work:** `memory_store(text="<durable fact>", tags="...",
  room="...", salience=0.8)` — decisions made, root causes found, conventions and
  gotchas learned. Exclude transient detail, secrets, and per-file noise.

On a code-mode gateway both run through `executeToolCode`, e.g.
`result = <memory-server>.memory_search(query="...", k=6)`. Confirm the server name
and exact signature with `listToolFiles` / `readToolFile` if unsure.

## Other capabilities

Route capability requests through whatever the gateway exposes — issue tracker,
error tracking, analytics, docs, web search — via flat tools or code-mode. When in
doubt, `listToolFiles` first; don't guess tool names.

## Onboarding / troubleshooting

- `/bifrost-onboard` — first-time setup walkthrough
- `/bifrost-debug` — diagnose MCP / skill-discovery failures
- `/bifrost-mcp-setup` — manual MCP wiring fallback
