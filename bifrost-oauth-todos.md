# OAuth Rollout — Open TODOs

Status as of 2026-07-07. The in-repo work is **done** (bridge + VK-sync job implemented
with 31 passing tests, Keycloak runbook written, plugin docs/skills updated, v1.1.0).
Everything below is deployment/ops work outside this repo, in rollout order.
Companion docs: [implementation plan](./bifrost-oauth-implementation-plan.md) ·
[bridge README](./bridge/README.md) · [Keycloak runbook](./bridge/docs/keycloak-setup.md).

## 1. Stable domain (blocker for everything OAuth)

- [ ] Provision DNS for the stable gateway host (working name `bifrost.luca-app.de`) → gateway machine.
- [ ] Confirm the final hostname — if it differs from `bifrost.luca-app.de`, update the placeholder in `README.md`, the compose example, and the skills.
- [ ] TLS termination (Caddy per `bridge/docker-compose.example.yml`, or existing ingress).
- [ ] Interim: point the domain at Bifrost directly so CLI users can migrate `BIFROST_URL` early; keep the zrok share alive during the transition window.
- [ ] Announce the `BIFROST_URL` change to existing CLI users (only the URL changes; VK auth is untouched).

## 2. Keycloak realm (IdP admin)

Follow [bridge/docs/keycloak-setup.md](./bridge/docs/keycloak-setup.md):

- [ ] Create/choose the realm (`mcp` recommended); federate the company user store; ensure `email` is populated + verified.
- [ ] Client scopes `mcp:read` / `mcp:write` with the **audience mapper** = the stable gateway origin (must equal `BRIDGE_PUBLIC_ORIGIN` exactly — tokens are rejected otherwise).
- [ ] Enable anonymous **DCR** with guardrail policies: trusted hosts, allowed redirect URIs (`https://claude.ai/api/mcp/auth_callback` + localhost loopback), allowed client scopes, consent on.
- [ ] Enforce **PKCE S256** via client policy (`pkce-enforcer`) on DCR-created clients.
- [ ] Set token lifetimes (short access token, refresh on).
- [ ] Verify: `curl <kc>/realms/mcp/.well-known/oauth-authorization-server` shows `registration_endpoint` and `S256`.
- [ ] Create the `bridge-test` client for minting test tokens (disable outside test windows).
- [ ] Confirm this Keycloak is the **same IdP** behind Bifrost's SSO login, so token emails match Bifrost's user records.

## 3. VK sync prerequisites (Bifrost admin)

- [ ] Mint an admin API credential for the sync job (`bfst-*` key or equivalent) — read access to `/api/governance/virtual-keys` is all it needs; store it in the secret store, not in files.
- [ ] Inspect one real response of the virtual-keys list call (dashboard dev-tools) and check where the user email and key value live; if not auto-detected, pin `VK_SYNC_EMAIL_PATH` / `VK_SYNC_VALUE_PATH`.
- [ ] Dry-run against the live gateway: `BIFROST_ADMIN_URL=… BIFROST_ADMIN_TOKEN=… VK_MAP_PATH=./vk-map.json npm run sync -- --dry-run` — expect a plausible user count, not 0.
- [ ] Decide the sync cadence (compose sidecar `SYNC_INTERVAL_SECONDS=300` is the default; cron one-shot also works).

## 4. Deploy the bridge (ops)

- [ ] Bring up the stack per `bridge/docker-compose.example.yml`: Caddy → bridge → Bifrost + `vk-sync` sidecar; Bifrost no longer publicly exposed (VK check can't be bypassed).
- [ ] Set bridge env: `BRIDGE_PUBLIC_ORIGIN` (stable origin), `BRIDGE_UPSTREAM_URL` (internal Bifrost), `KEYCLOAK_ISSUER`, `VK_MAP_PATH`.
- [ ] Integration checks against the live domain (also in the bridge README):
  ```bash
  curl -i https://<host>/mcp                                       # 401 + WWW-Authenticate: Bearer resource_metadata="…"
  curl -s https://<host>/.well-known/oauth-protected-resource      # PRM JSON listing the Keycloak issuer
  curl -s -o /dev/null -w "%{http_code}\n" -H "x-bf-vk: $BIFROST_VK" -X POST https://<host>/mcp \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'   # 200
  ```
- [ ] Token-path checks with a `bridge-test` token: valid → 200; minted without `mcp:read` → 403; wrong audience → 401; user not yet synced → 403 `no_virtual_key`.

## 5. End-to-end validation

- [ ] Clean-profile Claude Desktop → Settings → Connectors → add `https://<host>/mcp` → Keycloak login + consent → tools list. (This is the original `mcp_registration_failed` gone.)
- [ ] On that first connect, note the exact `redirect_uris` Desktop registered in Keycloak and tighten the DCR redirect-URI policy to match.
- [ ] New-user flow: fresh SSO user logs into Bifrost dashboard → VK auto-provisioned → Desktop works within one sync interval.
- [ ] Governance: the OAuth caller's mapped VK budget/rate-limits/tool-groups apply.
- [ ] Token lifecycle: expiry → silent refresh; Keycloak session revoke → access denied.
- [ ] Regression: Claude Code CLI with the new `BIFROST_URL` — `/mcp` connected, `skill_search` returns results.

## 6. Security review & cutover

- [ ] Run the Phase-7 checklist (plan §E): PKCE enforced, audience binding, Bearer never forwarded, VK/token never logged, deny-by-default, TLS everywhere, secrets mounted not committed.
- [ ] `npm audit` in `bridge/`; focused review of `bridge/src/auth.mjs` before rollout.
- [ ] Confirm the vk-map volume/file permissions (0600, sync job is the only writer).
- [ ] Retire the zrok share after the migration window; remove it from any docs/configs.
- [ ] Merge `feature/oauth` (repo work is complete on that branch, uncommitted).
