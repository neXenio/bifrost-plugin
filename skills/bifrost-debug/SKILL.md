---
name: bifrost-debug
description: "Diagnose why a Bifrost gateway, memory injection, or skill discovery isn't working in Claude Code or Claude Desktop. Triggers on 'bifrost not working', 'mcp not connecting', 'memory not injecting', 'skill_search failing', '401/403 from bifrost', 'bifrost debug', 'gateway unreachable', 'mcp_registration_failed', 'desktop connector failing', 'oauth error'."
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

## 4. Check the gateway's memory MCP tools (for agent-driven memory)

Run `/mcp` and look for a memory server under `bifrost`. If present, test it:

```
mcp__bifrost__<memory-server>-search("test connection")
```

If the tool is not found, the gateway exposes no memory server — memory calls will
simply not be available. This does not affect skill discovery or gateway connectivity.

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

## 7. Claude Desktop issues (OAuth path)

Desktop connects via OAuth through the gateway's bridge — not via `BIFROST_VK`.
Work through these in order:

1. **`mcp_registration_failed` on Connect** — is the connector URL the stable
   gateway domain (e.g. `https://bifrost.luca-app.de/mcp`)? Old ephemeral
   tunnel URLs (`*.share.zrok.io`) have no OAuth bridge and will always fail.
2. **Check OAuth discovery is live:**
   ```bash
   curl -s https://<stable-gateway-host>/.well-known/oauth-protected-resource   # → JSON with authorization_servers
   curl -si https://<stable-gateway-host>/mcp | grep -i www-authenticate        # → Bearer resource_metadata="…"
   ```
   Missing either → the bridge is down or misrouted (gateway operator issue).
3. **Check the authorization server supports DCR:**
   ```bash
   curl -s <keycloak>/realms/mcp/.well-known/oauth-authorization-server | grep registration_endpoint
   ```
   Missing → anonymous client registration is disabled in Keycloak; use the
   pre-registered client ID in the connector's Advanced settings instead.
4. **Login works but tools fail** — see the symptom map below (audience/scope/VK-map).

## Symptom → cause map

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on every bifrost call | `BIFROST_VK` wrong or missing | Set env var, restart CC |
| 403 | Key valid but no permission | Contact gateway operator |
| `skill_search` tool not found | bifrost MCP not loaded or no skill server | Check `~/.claude/mcp.json`; restart CC |
| Memory tool not found | Gateway exposes no memory server | Check with gateway operator; memory is optional |
| Gateway timeout | Gateway offline or wrong URL | Check `BIFROST_URL`; contact gateway operator |
| Desktop: `mcp_registration_failed` | Wrong/ephemeral URL, bridge down, or Keycloak DCR off | Steps 7.1–7.3 above |
| Desktop: `Invalid redirect URI` | Gateway public URL changed since the client registered, or DCR redirect-URI policy too strict | Remove + re-add the connector; operator: check Keycloak allowed redirect URIs |
| Desktop: 401 `invalid_token` after successful login | Token audience/issuer mismatch (Keycloak audience mapper missing or wrong `BRIDGE_PUBLIC_ORIGIN`) | Gateway operator: verify audience mapper = bridge origin |
| Desktop: 403 `insufficient_scope` | Token lacks the required `mcp:read` scope | Operator: add scope to the realm's default/allowed client scopes |
| Desktop: 403 `no_virtual_key` | Authenticated but not in the bridge's VK map (deny-by-default) | Operator: assign the user a VK in Bifrost (the sync job exports it within one interval), check the `vk-sync` job is running, or add a manual map entry |
| Desktop: access suddenly denied | Token expired without refresh, or Keycloak session revoked | Reconnect (re-login) in the connector |

For manual MCP wiring: `/bifrost-mcp-setup`.
For fresh onboarding: `/bifrost-onboard`.
