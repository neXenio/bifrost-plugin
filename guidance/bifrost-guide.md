# Bifrost gateway — Engineer Guide

## What is Bifrost?

Bifrost is a unified MCP gateway: a single HTTP endpoint that proxies to your
tooling (issue trackers, error tracking, analytics, docs, search, a memory
service, etc.) and can serve a shared skill library. Every Claude Code session
with this plugin enabled gets:

1. **Memory auto-injection** — relevant facts from the memory service are prepended
   to each prompt automatically (similarity-filtered, deduped, capped at 600 chars).
2. **Skill discovery** — non-trivial prompts receive a hint to call the gateway's
   skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) before starting,
   so existing workflows are reused.
3. **One-command onboarding** — `node bin/install.js --key vk_…` (or the
   `/bifrost-setup` slash command) wires the MCP entry in seconds.
4. **Session reflection** — on session end, key decisions and learnings are staged
   for ingestion into the memory service, so knowledge compounds across sessions.

## Prerequisites

- Node.js 18+ on PATH
- `BIFROST_URL` env var set to your gateway's `/mcp` endpoint
- `BIFROST_VK` env var set to your virtual key (issued by your gateway operator)
- Claude Code with the bifrost-plugin installed
- A memory service reachable at `${BIFROST_MEMORY_URL}` (defaults to the
  conventional local `http://127.0.0.1:52421`) for the memory features (Pillars 1
  + 4). Without it, memory injection and reflection silently no-op — the gateway
  and skill discovery still work.

## Configuration (env vars)

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Gateway `/mcp` endpoint | `https://your-bifrost-gateway.example/mcp` (placeholder) |
| `BIFROST_VK` | Virtual key for the `x-bf-vk` auth header | (unset — required) |
| `BIFROST_MEMORY_URL` | Memory service base URL | `http://127.0.0.1:52421` |
| `BIFROST_SKILLS_SERVER` | Name of the gateway's skill server | `skills` |

## Onboarding (first time)

```bash
# From the plugin root:
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js --key vk_<your-key>

# Or use the slash command inside Claude Code:
/bifrost-setup
```

The installer:
1. Merges the bifrost MCP server into `~/.claude/mcp.json` (idempotent — safe to
   run twice; backs up the existing file to `mcp.json.bak` and writes atomically).
2. Prints an `export BIFROST_VK=…` line. It does NOT touch your shell profile —
   you must paste that line into `~/.zshrc` (or `~/.bashrc`) yourself for the key
   to persist.
3. Tells you to restart CC, after which the gateway and skill-search tools are callable.

To append the skill-discovery MUST-stanza to your `~/.claude/CLAUDE.md`, the
`bifrost-onboard` skill offers to do this idempotently (skips if the
`## Skill Discovery` heading is already present).

## Manual MCP wiring (fallback)

If the installer can't run, add this block to `~/.claude/mcp.json` by hand:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "http",
      "url": "${BIFROST_URL}",
      "headers": { "x-bf-vk": "${BIFROST_VK}" }
    }
  }
}
```

Set `BIFROST_URL` and `BIFROST_VK` in your shell, restart Claude Code, and confirm
the `bifrost` server appears in `/mcp`.

## Hooks

The plugin registers three Claude Code hooks:

| Event | Hook file | What it does |
|-------|-----------|--------------|
| `SessionStart` | `session-start.cjs` | Injects `guidance/bifrost-context.md` (~400 tokens) as session context |
| `UserPromptSubmit` | `prompt-submit.cjs` | Memory enrichment + skill-discovery hint per prompt |
| `Stop` | `session-reflect.cjs` | Stages session learnings for ingestion into the memory service |

All hooks are silent-fail: any error results in `exit 0` with no output. A
crashed hook never blocks your session.

## Session reflection — how the knowledge flywheel works

On every session end (`Stop` event), `session-reflect.cjs` stages a JSON payload
to `~/.cache/bifrost-plugin/staging/` (file I/O only — no network on the exit
path). The next `SessionStart`, after emitting the context block, drains the
staging dir: for each staged file it POSTs any distilled `facts[]` to the memory
service write route `POST ${BIFROST_MEMORY_URL}/memory/store`, then moves the file
to `~/.cache/bifrost-plugin/processed/`. The memory service applies its own noise
classifier and semantic dedup (rejecting near-duplicates at similarity > 0.95), so
re-posts are harmless. `processed/` and `reflected/` are capped to the most recent
50 files.

One reflection per session (rate-limited by a marker file in
`~/.cache/bifrost-plugin/reflected/`). Duplicate sessions produce no duplicate
facts. If the memory service is down, the POST silently fails and the file is still
drained — Pillar 4 degrades gracefully.

## Troubleshooting

Use `/bifrost-debug` inside Claude Code for guided diagnosis. Quick checklist:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| 401 / 403 from bifrost | `BIFROST_VK` missing or wrong | Re-run setup or set `export BIFROST_VK=vk_<your-key>` |
| No memory injected | Memory service not running on `${BIFROST_MEMORY_URL}` | Start the service; plugin degrades gracefully |
| No skills found | bifrost MCP not loaded in CC | Check `~/.claude/mcp.json`; run `/bifrost-mcp-setup` |
| Hook not firing | Plugin not installed/enabled | Re-install / re-enable via `/plugin`; restart CC (hooks ship inside the plugin, not `settings.json`) |

## Gateway routing reference

Tools are namespaced `mcp__bifrost__<server>-<tool>`. Which servers exist depends
entirely on how your gateway is configured. Run `/mcp` to list them. Typical roles:

| Need | Server role | Notes |
|------|-------------|-------|
| Issue / ticket ops | issue tracker | create, read, search, comment |
| Production errors | error tracking | triage, root-cause |
| Analytics | analytics / database | queries against your data |
| Library docs | docs | always prefer over training data for SDK/API docs |
| Web search | search | current information outside the codebase |
| Past decisions / people | memory | also auto-injected; call search for targeted lookup |
| Skills | skills | `skill_search`, `skill_navigate`, `get_skill` |
