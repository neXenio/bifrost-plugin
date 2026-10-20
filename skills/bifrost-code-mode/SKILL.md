---
name: bifrost-code-mode
description: "Call Bifrost gateway MCP servers that are NOT exposed as flat tools, through the executeToolCode meta-tool. Triggers on 'executeToolCode', 'code mode', 'code-mode', 'listToolFiles', 'readToolFile', 'getToolDocs', 'starlark', 'tool not found on bifrost', 'no such tool mcp__bifrost__', 'no such tool mcp__plugin_bifrost-plugin_bifrost__', 'no such tool mcp__claude_ai_luca_Bifrost__', 'how do I call gitlab/jira/grafana/sentry through the gateway', 'gateway tool missing', 'server keys'."
---

# Bifrost code mode

Most servers on a Bifrost gateway are **not** flat tools. They do not appear in your
tool list and `<prefix><server>-<tool>` does not exist for them (`mcp__plugin_bifrost-plugin_bifrost__` from the plugin, `mcp__claude_ai_luca_Bifrost__` from the claude.ai connector, `mcp__bifrost__` from a hand-added server). They are reached
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

`fileName` is the catalog path exactly as `listToolFiles()` prints it. On our gateway
that is one file per server, `servers/<server>.pyi`; gateways with tool-level binding
use `servers/<server>/<tool>.pyi` instead.

## Workflow

**1. Discover.** `listToolFiles()` returns the catalog, one file per server:

```
servers/
  gitlab.pyi
  jira.pyi
  ...
```

**2. Confirm the signature.** Never call a tool whose parameters you have not read.

```
readToolFile(fileName="servers/jira.pyi")
```

returns typed stubs for every tool on that server, with the exact callable names and
inline descriptions:

```python
# jira server tools
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
`Execution completed successfully.` with no return value.

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
arithmetic. Not available: imports, file I/O, direct network calls, `try`/`except`,
f-strings (use `"%s" % x`). Reach the outside world only through the server functions.

**Built-in modules** (no import needed): `json.encode(obj)`, `json.decode(text)` and
`math` (`math.sqrt`, `math.floor`, ...).

**Failed calls do not abort the script.** A tool error comes back as a value with an
`error` field, so check it before indexing:

```python
p = gitlab.get_project(project_id="123")
if hasattr(p, "error"):
    result = "lookup failed: %s" % p.error
else:
    result = p["web_url"]
```

The reply then ends with `Execution completed, but 1 nested tool call failed.`

**Numbers keep their type.** Integer ids from tool results stay `int`, so `str(p["id"])`
gives `"87265108"`, not a float.

**Limits.** One script may make at most 64 tool calls. Batch or narrow the query
instead of looping over hundreds of items. Only `print()` output and `result` come
back; raw tool responses are not echoed, so print what you need while debugging.

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
| `nested tool call failed` | A call returned an error value; check `hasattr(r, "error")` |
| Script stops after many calls | 64 tool calls per script cap; split or batch |

## Relationship to flat tools

A gateway mixes both modes. Flat tools (`<prefix><server>-<tool>`) are already in
your tool list and should be called directly. Code mode is for everything else. A
server never appears in both, so if you can see it as a flat tool, do not route it
through `executeToolCode`.
