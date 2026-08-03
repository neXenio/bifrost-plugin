# Bifrost gateway — session context

You are connected to a **Bifrost MCP gateway**: a unified MCP proxy that routes to
the tools, skill library, and memory your gateway exposes.

| Item | Value |
|------|-------|
| MCP server | `bifrost` (from the plugin's `.mcp.json`, or user-scope via `claude mcp add`) |
| Gateway URL | `${BIFROST_URL}` |
| Auth | `x-bf-vk` header from `${BIFROST_VK}` |

> **Auth modes:** this session (Claude Code) authenticates with the virtual-key
> header above. Claude Desktop instead connects to the same gateway via OAuth
> (company Keycloak login — no key needed); its setup lives in the Desktop
> connector UI, not in `.mcp.json`. Same gateway, same tools either way.

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

   Discover what code-mode offers with `listToolFiles()`, then
   `readToolFile(fileName="servers/<server>/<tool>.pyi")` to confirm parameters, and
   `getToolDocs(server=..., tool=...)` for full docs. Note the parameter is
   `fileName`, not `path`.

   Starlark notes: **assign what you want back to `result`** or the call returns
   nothing. `for`, `if`, list comprehensions and `print()` all work at top level.
   Load the `bifrost-code-mode` skill for the full reference.

If a `mcp__bifrost__<server>-<tool>` tool does not exist, the capability is almost
certainly code-mode — do **not** give up; use `executeToolCode`.

## Skills, memory and tools

The sections below this one are generated per session from *your* gateway: the skill
library and how to search it, the MCP tool roster, and the shared memory corpus with
its live size. Use those exact invocations — they are discovered, not guessed.

If they are absent, discovery has not run yet (first session here, or the gateway was
unreachable). In that case: `skill_search(query="<task>", k=5)` then
`get_skill(name=...)` to find and load a skill; `memory_search(query="...", k=6)`
before non-trivial work. Before storing, check the advertised `memory_store` schema.
For luca-memory v0.40, provide `subject`, ISO 8601 `valid_from`, and `text` (or `body`)
— application `tenant` was removed; a stale catalog may still show it, but it is only a
temporary ignored compatibility input and must not be invented. In a collective Bifrost
deployment, a successful store returns `{"status":"pending","candidate_id":"..."}`:
the claim is staged for collective review, not yet shared knowledge. Local/private mode
can instead return `queued` or `stored`. Store only privacy-safe, durable facts after
significant work. Use `listToolFiles()` to see what else the gateway exposes, and
confirm server names there rather than guessing.

## Onboarding / troubleshooting

- `/bifrost-onboard` — first-time setup walkthrough
- `/bifrost-debug` — diagnose MCP / skill-discovery failures
- `/bifrost-mcp-setup` — manual MCP wiring fallback
