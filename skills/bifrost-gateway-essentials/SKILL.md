---
name: bifrost-gateway-essentials
description: "How to actually use a Bifrost gateway: most of its servers are NOT flat tools — a missing mcp__bifrost__<server>-<tool> means the capability is in code mode, reachable by running a Starlark snippet through the executeToolCode meta-tool, with listToolFiles() to discover what exists. Search the skill library (skill_search) and the shared memory (memory_search) before non-trivial work, and store durable facts after. Read this before concluding a gateway capability is missing, and on any surface where no bifrost session context was injected."
---

# Bifrost gateway essentials

This skill carries the operating rules for a Bifrost gateway in a form that does
not depend on hooks. The plugin's SessionStart hook normally injects a richer,
gateway-specific version of this at the top of every session — but hooks only run
in the Claude Code CLI and in Claude Desktop's Code and Cowork tabs. On Desktop's
Chat tab and on claude.ai web, nothing is injected, so this skill is the fallback.
Its description is loaded on every surface whether or not the skill is invoked.

If you *did* get an injected bifrost context block this session, prefer it: it was
generated from your actual gateway and names real servers, whereas this skill can
only describe the shape.

## The one thing that trips everyone up

Run `/mcp` to see what loaded. A gateway exposes upstream servers in two modes,
and the same gateway usually mixes both:

1. **Flat tools** — callable directly, namespaced `mcp__bifrost__<server>-<tool>`
   (for example `mcp__bifrost__skills-skill_search`).
2. **Code mode** — most servers are *not* flat tools and never appear in your tool
   list. They are reached through the meta-tool `executeToolCode`, which runs a
   short Starlark snippet:

   ```
   result = <server>.<tool>(param="value")
   ```

So a tool that does not exist in your tool list is weak evidence that the gateway
lacks the capability, and strong evidence that the capability is in code mode.
Discover what is there with `listToolFiles()`, then `getToolDocs()` / `readToolFile()`
for signatures. Confirm server names from that listing rather than guessing them.

`/bifrost-code-mode` covers this path in full.

## Before non-trivial work

- `skill_search(query="<the task>", k=5)`, then `get_skill(name=...)` to load a
  match. The gateway's skill library is the point of the gateway; searching it is
  cheap and skipping it is how work gets redone.
- `memory_search(query="...", k=6)` for prior decisions and constraints.

## After significant work

Store durable, privacy-safe facts only. Check the advertised `memory_store` schema
before calling it — for luca-memory v0.40 that means `subject`, an ISO 8601
`valid_from`, and `text` (or `body`). The `tenant` argument was removed; a stale
tool catalog may still list it, but it is an ignored compatibility input and must
not be invented.

Read the return value rather than assuming success. In a collective deployment a
successful store returns `{"status":"pending","candidate_id":"..."}` — the claim is
staged for review, not yet shared knowledge. Local or private mode returns `queued`
or `stored` instead.

## When something looks broken

A search that returns results is not proof that memory works — it passes just as
happily against a stale or wrong corpus. The test that distinguishes them is two
calls: store a tracer fact, then search for it.

`/bifrost-debug` walks the full decision tree for connection, auth, and discovery
failures.
