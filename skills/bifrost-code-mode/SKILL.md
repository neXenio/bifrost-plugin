---
name: bifrost-code-mode
description: "Call Bifrost gateway MCP servers that are NOT exposed as flat tools, through the executeToolCode meta-tool. Triggers on 'executeToolCode', 'code mode', 'code-mode', 'listToolFiles', 'readToolFile', 'getToolDocs', 'starlark', 'tool not found on bifrost', 'no such tool mcp__bifrost__', 'how do I call gitlab/jira/grafana/sentry through the gateway', 'gateway tool missing', 'server keys'."
---

# Bifrost code mode

Most servers on a Bifrost gateway are **not** flat tools. They do not appear in your
tool list and `mcp__bifrost__<server>-<tool>` does not exist for them. They are reached
by writing a short Starlark snippet and running it with `executeToolCode`.

If a capability seems missing, it is almost certainly here. Do not conclude the gateway
lacks it, and do not fall back to guessing from training data, until you have checked.

## The four meta-tools

Exact schemas, as the gateway advertises them:

| Tool | Parameters | Required |
|---|---|---|
| `listToolFiles` | *(none)* | — |
| `readToolFile` | `fileName`, `startLine`, `endLine` | `fileName` |
| `getToolDocs` | `server`, `tool` | both |
| `executeToolCode` | `code` | `code` |

The parameter is `fileName`, **not** `path` or `file`. Passing `path` fails with
`fileName parameter is required and must be a string`.

`fileName` is the full catalog path: `servers/<server>/<tool>.pyi`.

## Workflow

**1. Discover.** `listToolFiles()` returns the catalog, grouped by server:

```
servers/
  jira/
    search_jira_tickets.pyi
    create_jira_ticket.pyi
    ...
```

**2. Confirm the signature.** Never call a tool whose parameters you have not read.

```
readToolFile(fileName="servers/jira/search_jira_tickets.pyi")
```

returns a typed stub with the exact callable name and an inline description:

```python
# Total lines: 10 (this is the complete file, no need to paginate)
# jira.search_jira_tickets tool
# Usage: jira.tool_name(param=value)
def search_jira_tickets(query: str, max_results: float = None, service: str = None, status: str = None) -> dict:  # Search JIRA before filing a new ticket to avoid duplicates.
```

The `def` name is the exact callable. Descriptions in `.pyi` files may be truncated —
use `getToolDocs(server="jira", tool="search_jira_tickets")` when a parameter's meaning
or return shape is unclear.

A wrong tool name is cheap to recover from: the error lists every valid tool on that
server.

**3. Execute.**

```
executeToolCode(code='result = jira.search_jira_tickets(query="payment webhook", max_results=5)')
```

## Starlark rules

The runtime is Starlark, a Python subset.

**Assign to `result`.** Nothing comes back unless you do. This is the single most
common mistake, and it fails quietly — the call reports
`Execution completed but produced no data`.

```python
result = gitlab.create_issue(project_id="123", title="Fix webhook")   # correct
gitlab.create_issue(project_id="123", title="Fix webhook")            # returns nothing
```

**Call tools with keyword arguments**: `server.tool(param=value)`, as the `.pyi` stub
shows.

**Top-level `for` and `if` are fine** — verified on a live gateway. Older Bifrost
documentation says they must be wrapped in a `def`; that is not true of this runtime,
and neither form is wrong:

```python
keys = []
for t in jira.search_jira_tickets(query="webhook")["issues"]:
    if t["status"] == "Open":
        keys.append(t["key"])
result = keys
```

**`print()` works** and its output is returned alongside the result, which makes it
the practical way to debug a snippet.

Supported: `def`, `for`, `if`, list comprehensions, dicts, lists, string ops,
arithmetic. Not available: imports, file I/O, direct network calls. Reach the outside
world only through the server functions.

## Why this beats one flat tool per call

The snippet runs server-side, so a multi-step task costs **one** round trip and only
the final `result` enters your context. Filter and aggregate inside the snippet rather
than pulling everything back:

```python
def open_bugs():
    tickets = jira.search_jira_tickets(query="checkout", max_results=50)
    return [t["key"] for t in tickets["issues"] if t["status"] == "Open"]

result = open_bugs()
```

That returns a handful of keys instead of 50 full ticket bodies.

## Checking what is available

`executeToolCode` reports the live server keys in its `Environment` block on every
run, so a trivial snippet tells you what this key can reach:

```
executeToolCode(code="result = 1")
→ Available server keys: gitlab, grafana, jira, sentry, hubspot, metabase,
  clarity, context7, exa, markitdown, perplexity, spinach, sequentialthinking
```

The roster is scoped to your virtual key: servers you may not call are absent, so
anything listed is genuinely callable.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `fileName parameter is required` | Used `path=` instead of `fileName=` |
| `Tool 'x' not found in server 'y'` | Wrong tool name; the error lists the valid ones |
| Execution succeeds, no value | Missing `result =` assignment |
| Syntax error on `for`/`if` | Top-level control flow; move it into a `def` |
| Server key undefined | Not in your key's scope — check the `Environment` block |

## Relationship to flat tools

A gateway mixes both modes. Flat tools (`mcp__bifrost__<server>-<tool>`) are already in
your tool list and should be called directly. Code mode is for everything else. A
server never appears in both, so if you can see it as a flat tool, do not route it
through `executeToolCode`.
