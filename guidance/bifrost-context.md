# Bifrost gateway — session context

You are connected to a **Bifrost MCP gateway**: a unified MCP proxy that routes to
the tools, skill library, and memory your gateway exposes.

| Item | Value |
|------|-------|
| MCP server | `bifrost` (from the plugin's `.mcp.json`, or user-scope via `claude mcp add`) |
| Gateway URL | `${BIFROST_URL}` |
| Auth | `x-bf-vk` header from `${BIFROST_VK}` |

> **Auth modes:** every surface authenticates with the virtual-key header above.
> The plugin collects the gateway URL and the key as install-time plugin config,
> so Claude Desktop and claude.ai work without any shell environment. `BIFROST_URL`
> and `BIFROST_VK` still override it for the hook layer.
>
> Signing in with a company account instead of a key is not available yet. The
> gateway offers the OAuth challenge, but its authorization server does not permit
> client registration from a desktop client, so the flow cannot complete. Use a
> virtual key until that changes.
>
> **Surfaces:** hooks and subagents run in the Claude Code CLI and in Claude
> Desktop's Code and Cowork tabs. They do not run in Desktop's Chat tab or in
> claude.ai web chat, so on those two the memory injection, skill-discovery hints,
> and usage tracking below are inactive. Skills, slash commands, and the gateway's
> MCP tools work everywhere.

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
`get_skill(name=...)` to find and load a skill; `memory_search(query="...", limit=6)`
before non-trivial work.

**Read the advertised schema rather than trusting this paragraph.** The memory
contract below is luca-memory v0.42.

- `memory_search(query, limit, scope, tier, filters, detail)`. `scope` is `search`
  (rank by meaning), `graph` (follow connections outward) or `session` (what is hottest
  right now, no query needed); `tier` is `hot`, `cold` or `all`. `filters` is an object
  narrowing by exact value on `subject`/`wing`/`room`/`agent_id`/`conversation_id`.
  Hits carry `content` and `relevance`.
- `memory_store(subject, text)`, with `body` for anything longer than a fact and
  `items=[...]` to store several at once. Do not send `valid_from` — the server stamps
  its own UTC time. `tenant`, `role` and `vk` are schema errors; a stale gateway
  catalog may still list them, but they must not be invented.
Those two are the whole of normal use: search before the work, store after it. You
should not need anything else.

The advanced surface, when you genuinely do, is `memory_call(action=..., request=...)`:
corpus statistics, a memory's markdown body (`meta.get_full`), corrections, linking,
pruning. Actions are namespaced and the prefix is the contract — `evolve.*` changes the
corpus, `meta.*` only reads it — and a bare name like `"stats"` is an error rather than
an alias. Reach for it deliberately, not as part of a normal recall-then-store loop.

A store returns `stored` or `queued`; `{"status":"skipped","reason":"noise"}` means the
noise classifier dropped it, and `force=true` resends a fact it dropped wrongly. Store
only privacy-safe, durable facts after significant work. Use `listToolFiles()` to see
what else the gateway exposes, and confirm server names there rather than guessing.

## Onboarding / troubleshooting

- `/bifrost-onboard` — first-time setup walkthrough
- `/bifrost-debug` — diagnose MCP / skill-discovery failures
- `/bifrost-mcp-setup` — manual MCP wiring fallback
