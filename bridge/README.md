# Bifrost OAuth Bridge

A small reverse proxy that sits in front of a [Bifrost](https://github.com/maximhq/bifrost)
MCP gateway and makes its `/mcp` endpoint an **OAuth 2.1 protected resource**, so
Claude Desktop's zero-config Connect flow works (no more `mcp_registration_failed`).
Claude Code CLI users with an `x-bf-vk` header pass through untouched.

## What it does

| Request | Behavior |
|---|---|
| Has `x-bf-vk` / `x-api-key` | Forwarded to Bifrost as-is (existing CLI path, zero change) |
| Has `Authorization: Bearer <jwt>` | Validated against Keycloak (issuer, signature via JWKS, expiry, **audience = this origin** per RFC 8707, required scope), then the user's `email`/`sub` claim is resolved to a per-user virtual key which is injected as `x-bf-vk`. The Bearer is stripped before forwarding. Unmapped users are **denied** (403). |
| No credentials | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` so MCP clients discover OAuth |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 Protected Resource Metadata pointing at the Keycloak realm |
| `GET /healthz` | Liveness probe |

## Configuration (env vars)

| Var | Required | Meaning |
|---|---|---|
| `BRIDGE_PUBLIC_ORIGIN` | yes | Stable public origin, e.g. `https://bifrost.luca-app.de`. Used as the PRM `resource` identifier and the required token `aud`. Must never change once clients are registered. |
| `BRIDGE_UPSTREAM_URL` | yes | Internal Bifrost base URL, e.g. `http://bifrost:8080` |
| `KEYCLOAK_ISSUER` | yes | Realm issuer URL, e.g. `https://keycloak.luca-app.de/realms/mcp` (JWKS is derived from it) |
| `VK_MAP_PATH` | yes | Path to the claim→VK JSON map (mount as a secret; see `vk-map.example.json`) |
| `BRIDGE_REQUIRED_SCOPE` | no | Scope every token must carry (default `mcp:read`) |
| `PORT` | no | Listen port (default `8787`) |
| `LOG_LEVEL` | no | Pino level (default `info`). `authorization`, `x-bf-vk`, and `x-api-key` headers are always redacted. |

## VK map

```json
{ "users": { "alice@luca-app.de": "vk_...", "<keycloak-sub>": "vk_..." } }
```

Keys are matched against the token's `email` claim first, then `sub`
(case-insensitive). The file is hot-reloaded on change (best effort — a
restart always applies it). **Deny-by-default:** an authenticated user with
no entry gets `403 no_virtual_key`, never a shared fallback key. Keep the
real map out of git (`vk-map.json` is gitignored); mount it read-only.

### Populating the map — periodic export from Bifrost (recommended)

If your Bifrost deployment provisions per-user virtual keys via SSO, don't
maintain the map by hand — run the sync job, which exports Bifrost's own
user→VK table into `vk-map.json`:

```bash
BIFROST_ADMIN_URL=http://bifrost:8080 \
BIFROST_ADMIN_TOKEN=bfst-... \
VK_MAP_PATH=./vk-map.json \
npm run sync -- --dry-run   # then without --dry-run
```

- **One-shot** by default (cron / systemd timer); set `SYNC_INTERVAL_SECONDS`
  to loop (see the `vk-sync` sidecar in the compose example).
- Fetches `GET $BIFROST_ADMIN_URL/api/governance/virtual-keys` with
  `Authorization: Bearer $BIFROST_ADMIN_TOKEN` (override the header name via
  `BIFROST_ADMIN_AUTH_HEADER` if your deployment expects something else).
- The response shape varies by Bifrost version: extraction tries common field
  locations (`user.email`/`user_email`/`email`; `value`/`key`) and skips
  team/customer keys with no user attribution. Inspect one real response
  (dashboard dev-tools → the virtual-keys list call), then pin the exact
  fields with `VK_SYNC_EMAIL_PATH` / `VK_SYNC_VALUE_PATH` (dot paths).
- Writes atomically (tmp + rename, mode 0600) and only on change; the bridge
  hot-reloads. **Refuses to write an empty map** (likely an API/shape problem,
  not a zero-user gateway) unless `--allow-empty` is passed.
- The admin token is only ever used by this job — the bridge itself never
  holds admin credentials.
- Point `BIFROST_ADMIN_URL` at the **internal** Bifrost address; new SSO
  users get gateway access within one sync interval of first login.

## Run

```bash
npm install
BRIDGE_PUBLIC_ORIGIN=https://bifrost.luca-app.de \
BRIDGE_UPSTREAM_URL=http://127.0.0.1:8080 \
KEYCLOAK_ISSUER=https://keycloak.luca-app.de/realms/mcp \
VK_MAP_PATH=./vk-map.json \
npm start
```

Or via Docker: see [docker-compose.example.yml](./docker-compose.example.yml)
(Caddy terminates TLS; only Caddy is public).

## Test

```bash
npm test
```

## Keycloak setup

See [docs/keycloak-setup.md](./docs/keycloak-setup.md) for the realm runbook
(DCR policies, PKCE enforcement, audience mapper, test client).

## Verify a deployment

```bash
# 401 + WWW-Authenticate with resource_metadata:
curl -i https://bifrost.luca-app.de/mcp

# PRM document listing the Keycloak realm:
curl -s https://bifrost.luca-app.de/.well-known/oauth-protected-resource

# CLI regression — virtual key still works:
curl -s -o /dev/null -w "%{http_code}\n" -H "x-bf-vk: $BIFROST_VK" \
  -X POST https://bifrost.luca-app.de/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
