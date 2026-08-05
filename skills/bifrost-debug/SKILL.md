---
name: bifrost-debug
description: "Diagnose why a Bifrost gateway, memory injection, or skill discovery isn't working in Claude Code or Claude Desktop. Triggers on 'bifrost not working', 'mcp not connecting', 'memory not injecting', 'skill_search failing', '401/403 from bifrost', 'bifrost debug', 'gateway unreachable', 'mcp_registration_failed', 'desktop connector failing', 'oauth error', 'incompatible auth server', 'dynamic client registration', 'trusted hosts'."
---

# Bifrost Diagnostics

Work through this decision tree to isolate and fix the problem.

## 1. Check credentials are set (shell env, or plugin config)

On the CLI:

```bash
echo "URL set: ${BIFROST_URL:+yes}${BIFROST_URL:-NO — missing}"
echo "VK set: ${BIFROST_VK:+yes}${BIFROST_VK:-NO — missing}"
```

If missing: `export BIFROST_URL=https://<your-gateway-host>/mcp` and
`export BIFROST_VK=vk_<your-key>` (add both to `~/.zshrc` or `~/.bashrc`).

On Desktop and claude.ai there is no shell, so this check does not apply.
Credentials come from the plugin's three install-time config values
(`gateway_url`, `virtual_key`, `oauth_client_id`). Run `/plugin configure` to
view or change them.

Symptom if the key is wrong/missing: 401 or 403 from every bifrost tool call.

## 2. Check the bifrost MCP server is registered

```bash
claude mcp get bifrost 2>/dev/null || echo 'bifrost: MISSING at user scope'
```

The server can come from either the plugin's shipped `.mcp.json` (plugin
installed + enabled → shows up in `/mcp`) or a user-scope registration.
If neither: run `/bifrost-mcp-setup` for manual wiring instructions.
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

## 7. Tool schema is stale after an upstream MCP upgrade

Suspect a stale gateway catalog when either of these happens:

- a tool call fails with `Missing required argument` even though the call matches the
  schema exposed to the client; or
- the gateway advertises a schema that differs from what the upstream MCP server now
  accepts.

Bifrost publishes the tool catalog it captured when the **gateway process started**.
Restarting or upgrading an upstream MCP server does not refresh that published
snapshot.

### Diagnose

Compare the two catalog views:

1. `GET /api/mcp/clients` through the admin API reads the live upstream client and
   shows the upstream's current schema.
2. Send a JSON-RPC `tools/list` POST to the public MCP endpoint with the `x-bf-vk`
   header. This is the schema Bifrost is actually advertising to MCP callers.

If the admin response is newer than `tools/list`, the gateway catalog is stale.

These do **not** refresh that snapshot:

- reconnecting inside Claude Code with `/mcp` — the client only reads the same stale
  gateway catalog again;
- `POST /api/mcp/client/{uuid}/reconnect` — it may return
  `{"message":"MCP client reconnected successfully"}`, but it only re-establishes the
  upstream transport. Use the UUID form when diagnosing transport problems; the
  name-based variant may return 500;
- `tool_sync_interval` — it cannot repair the published snapshot when
  `config_mcp_clients.discovered_tools_json` is empty, as it was in the observed
  failure even though the row had `updated_at = 2026-06-30`.

**Fix:** restart the Bifrost gateway process, then repeat the public `tools/list` call
and confirm that it matches the admin view.

During the stale window, calls can still succeed if you pass the upstream's new
arguments explicitly: the upstream server validates the call, not the gateway's
cached catalog.

## 8. Collective luca-memory is unexpectedly writing locally

luca-memory v0.40 has two deployment modes. The Bifrost company corpus must run with
`MEMORY_DEPLOYMENT_MODE=collective`: `memory_store(subject=..., valid_from=..., text=...)`
then returns `{"status":"pending","candidate_id":"..."}` and does **not** write the
fact directly. `queued` or `stored` means the service is operating in local/private
mode, so do not call the result shared company knowledge.

Collective mode also requires Bifrost to inject the authenticated virtual-key identity
as `x-bifrost-vk-id` to the upstream luca-memory request. A missing header fails closed
with an error naming the trusted Bifrost VK identity. The declarative client entry is
`mcp-clients/clients.json` in the gateway repo.

Do **not** use Bifrost's `allowed_extra_headers` to forward a caller-supplied
`x-bifrost-vk-id`: that would let a caller forge a voter identity. Bifrost v1.5.16's
MCP client configuration can forward allowlisted caller headers but cannot derive the
validated VK ID into a new header. This needs a trusted gateway-side extension/proxy,
then a public `tools/list` recheck after the catalog refresh.

## 9. Claude Desktop OAuth does not complete

A virtual key is the one auth path verified fully working on Desktop, on every
tab, with no shell environment at all. Leaving `virtual_key` blank at install
falls back to OAuth against the identity provider named in the plugin's OAuth
config (`idms.nexenio.com/realms/nexenio`), and that path has two known
identity-provider-side failures before login even starts.

1. **Check the resource-server side of discovery** (this part works):
   ```bash
   curl -s https://bifrost.culture4.life/.well-known/oauth-protected-resource
   # → 200, authorization_servers: ["https://idms.nexenio.com/realms/nexenio"]
   curl -si https://bifrost.culture4.life/mcp | grep -i www-authenticate
   # → Bearer resource_metadata="https://bifrost.culture4.life/.well-known/oauth-protected-resource"
   ```
2. **Check the authorization-server side** (this is where it fails today):
   ```bash
   curl -s https://idms.nexenio.com/realms/nexenio/.well-known/openid-configuration \
     | grep registration_endpoint
   ```
   No `registration_endpoint` in the response is why dynamic client
   registration fails. See the symptom map below for the exact error text.
3. **Supplying an OAuth client ID** (the plugin's third config field, or
   `/plugin configure`) skips self-registration and reaches a healthy "Needs
   authentication" state. Completing the browser login from there still needs
   the identity provider to allow the redirect URI
   `http://localhost:51789/callback` for that client. Confirm this with your
   gateway operator before assuming the client ID itself is wrong.
4. **After a successful login**, the gateway maps the authenticated identity
   to a personal virtual key server-side. `no_virtual_key` at that point means
   the operator has not added you to that map yet.

Fix, in order of what you control. Use a virtual key: it works today and needs
no identity-provider change. For OAuth specifically, ask your gateway operator
to relax the realm's Trusted Hosts policy for loopback client registration, or
to pre-register a public client and give you its ID to paste into the OAuth
client ID field.

## Symptom → cause map

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on every bifrost call | `BIFROST_VK` wrong or missing (or the plugin's `virtual_key` config wrong) | Set env var, or `/plugin configure`, then restart |
| 403 | Key valid but no permission | Contact gateway operator |
| `skill_search` tool not found | bifrost MCP not loaded or no skill server | Check `claude mcp get bifrost` / `/mcp`; restart CC |
| Memory tool not found | Gateway exposes no memory server | Check with gateway operator; memory is optional |
| Gateway timeout | Gateway offline or wrong URL | Check `BIFROST_URL`; contact gateway operator |
| Literal `${BIFROST_URL}` or `${BIFROST_VK}` shows up as a server URL or header value | Plugin version before 1.5.0 running on a surface with no shell environment (Desktop, claude.ai), so the placeholder is never resolved | Update to bifrost-plugin 1.5.0 or later |
| `Incompatible auth server: does not support dynamic client registration` | Gateway's `/.well-known/oauth-authorization-server` has no `registration_endpoint` | Identity-provider side. Use a virtual key, or ask the operator for an OAuth client ID (step 9.3) |
| `Policy 'Trusted Hosts' rejected request to client-registration service. Details: Host not trusted.` | Keycloak's realm Trusted Hosts policy blocks direct client registration | Identity-provider side. Ask the operator to relax Trusted Hosts for loopback, or provide a client ID |
| Desktop: stuck at "Needs authentication" after entering an OAuth client ID | Identity provider has not allowlisted `http://localhost:51789/callback` as a redirect URI for that client | Operator: add the redirect URI to the client |
| Desktop: `no_virtual_key` after a successful login | Authenticated but not yet in the gateway's VK map | Operator: assign the user a virtual key |
| Permission prompt on every gateway tool | Normal Claude Code behaviour — no rule pre-approves the server | Add `"mcp__plugin_bifrost-plugin_bifrost"` (and/or `"mcp__bifrost"`) to `permissions.allow` in `~/.claude/settings.json`. The plugin cannot ship this: a plugin manifest may only carry `agent` and `subagentStatusLine` settings, and a `permissions` block there validates but is dropped at load |
| Tool exists on the gateway but not in your tool list | Server is code-mode, not flat | Call it via `executeToolCode`; `listToolFiles()` to discover. See `/bifrost-code-mode` |

For manual MCP wiring: `/bifrost-mcp-setup`.
For fresh onboarding: `/bifrost-onboard`.

## Memory check-ins are not appearing

The `Stop` hook asks about memory candidates from the third turn of a session, then
every eight. It stays silent when:

- the session is shorter than three turns (deliberate — one-shot questions are not
  interrupted);
- no gateway credential resolves (same check as everything else here — see step 1);
- no memory server was discovered, so `~/.cache/bifrost-plugin/discovery.json` has a
  null `memory` field;
- its marker file says this session was already asked recently. Markers live in
  `~/.cache/bifrost-plugin/reflect/` and are pruned after two days.

It is registered `async`, so its text arrives on the **next** turn, not the one that
triggered it. A check-in fired by the final turn of a session is never delivered.

Findings land in `.bifrost/candidates.md` in the project root, git-ignored. Review
them with `/bifrost-candidates`. If that file is missing, nothing has been recorded
in this project yet — that is not a fault.

## `mcp__bifrost__*` tools missing, but `claude mcp list` says connected

Almost always a **server-name collision**, not a gateway fault. Both install methods
register a server named `bifrost`: the plugin's bundled `.mcp.json` (using
`${BIFROST_URL}`) and `claude mcp add`. With both present, the project entry cannot
expand and the name resolves to nothing usable — so the tools vanish in any directory
containing that `.mcp.json`, while a connected `bifrost` still appears in the list.

Confirm:

```
claude mcp list | grep -i bifrost
```

A line reading `Missing environment variables: BIFROST_URL` alongside a connected
entry at a real URL is the collision. SessionStart also emits an explicit notice.

Fix, either one:

- `export BIFROST_URL=… BIFROST_VK=…` so the project entry resolves, or
- `claude mcp remove bifrost -s user` and let the plugin's entry own the name.

Note the hooks are **unaffected** either way — they read the credential from
`~/.claude.json` directly, so skills, memory and the tool roster keep working even
while the MCP tools are missing. That asymmetry is what makes this confusing.
