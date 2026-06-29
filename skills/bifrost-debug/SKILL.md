---
name: bifrost-debug
description: "Diagnose why a Bifrost gateway, memory injection, or skill discovery isn't working in Claude Code. Triggers on 'bifrost not working', 'mcp not connecting', 'memory not injecting', 'skill_search failing', '401/403 from bifrost', 'bifrost debug', 'gateway unreachable'."
---

# Bifrost Diagnostics

Work through this decision tree to isolate and fix the problem.

## 1. Check BIFROST_URL and BIFROST_VK are set

```bash
echo "URL set: ${BIFROST_URL:+yes}${BIFROST_URL:-NO — missing}"
echo "VK set: ${BIFROST_VK:+yes}${BIFROST_VK:-NO — missing}"
```

If missing: `export BIFROST_URL=https://<your-gateway-host>/mcp` and
`export BIFROST_VK=vk_<your-key>` (add both to `~/.zshrc` or `~/.bashrc`).
Symptom if the VK is wrong/missing: 401 or 403 from every bifrost tool call.

## 2. Check bifrost is in ~/.claude/mcp.json

```bash
node -e "const m=require(require('os').homedir()+'/.claude/mcp.json'); console.log(m.mcpServers?.bifrost ? 'bifrost: OK' : 'bifrost: MISSING')"
```

If missing: run `/bifrost-mcp-setup` for manual wiring instructions.
Then restart Claude Code for CC to pick up the change.

## 3. Check gateway reachability

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-bf-vk: ${BIFROST_VK}" \
  "${BIFROST_URL}"
```

Expected: 200 or 405 (OPTIONS probe). 401 → bad VK. Timeout / connection refused → gateway down or `BIFROST_URL` wrong (contact the gateway operator).

## 4. Check the memory service (for memory injection)

```bash
curl -s "${BIFROST_MEMORY_URL:-http://127.0.0.1:52421}/health"
```

If the service is not running, memory injection silently skips (the hook degrades gracefully). Start the memory service to restore auto-injection.

## 5. Check the plugin is installed and enabled

The hooks ship inside the plugin (via `hooks/hooks.json`), so they are managed by
the CC plugin subsystem — they do NOT appear in `~/.claude/settings.json`. Verify
the plugin itself instead:

```bash
# Is bifrost-plugin present in the CC plugins dir?
find ~/.claude/plugins -maxdepth 4 -type d -name 'bifrost-plugin*' 2>/dev/null

# Is it enabled? (enabledPlugins lives in ~/.claude.json)
node -e "
const fs=require('fs'), os=require('os');
let cfg={};
try { cfg=JSON.parse(fs.readFileSync(os.homedir()+'/.claude.json','utf8')); } catch {}
const ep=JSON.stringify(cfg.enabledPlugins||cfg.plugins||{});
console.log('bifrost-plugin enabled:', ep.includes('bifrost-plugin') ? 'yes' : 'no / unknown');
"
```

If the plugin is missing or disabled: re-install / re-enable it via `/plugin`
(or `/plugin install bifrost-plugin`), then restart Claude Code so the hooks load.

## 6. Test skill_search directly

If your gateway exposes a skill server, inside Claude Code call:
```
mcp__bifrost__<skills-server>-skill_search("test connection")
```

- Returns results → MCP and skill routing are working.
- Tool not found → bifrost MCP server not loaded in this session (restart CC), or your gateway has no skill server.
- 401/403 → re-check VK (step 1).

## Symptom → cause map

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on every bifrost call | `BIFROST_VK` wrong or missing | Set env var, restart CC |
| 403 | Key valid but no permission | Contact gateway operator |
| `skill_search` tool not found | bifrost MCP not loaded or no skill server | Check `~/.claude/mcp.json`; restart CC |
| No `<bifrost-memory>` block | Memory service down or plugin not loaded | Start service; check plugin (step 5) |
| Hook fires but memory empty | Service up but no matching memories | Normal for new installs; add some context first |
| Session reflection not staging | Permissions on `~/.cache/bifrost-plugin/` | `mkdir -p ~/.cache/bifrost-plugin/{staging,reflected}` |
| Gateway timeout | Gateway offline or wrong URL | Check `BIFROST_URL`; contact gateway operator |

For manual MCP wiring: `/bifrost-mcp-setup`.
For fresh onboarding: `/bifrost-onboard`.
