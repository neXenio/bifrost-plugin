# Implementation Plan — OAuth Support for the Bifrost Plugin

**Goal:** Let Claude Desktop users connect to the luca Bifrost gateway without hitting `mcp_registration_failed`. Two paths: a **local header-injecting proxy** (fast, no gateway changes) or **full OAuth** on the gateway (zero-config Connect, no local process).

**Author context:** Prepared for the `bifrost-plugin` customization (gateway `https://bifrostadmin108.share.zrok.io/mcp`, skill server `lucaskills`).

---

## 1. Problem statement & root cause

**Scope of the failure:** `mcp_registration_failed` blocks **Claude Desktop's zero-config Connect flow specifically**. Claude Code CLI already works today via `--header` / `${BIFROST_VK}` in `.mcp.json`. The Desktop connector UI and `claude_desktop_config.json` remote-server schema offer **only OAuth or no-auth** — there is no field for custom headers or a static Bearer token ([anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112)).

When a user clicks Connect on a remote URL, Desktop drives the **MCP authorization flow** (OAuth 2.1). On an unauthenticated request it expects the server to return `401` with a `WWW-Authenticate` header pointing at OAuth metadata, then discovers an authorization server and either registers dynamically or uses a pre-set client.

The luca gateway today does **only virtual-key auth**. Verified directly against the live endpoint:

- No auth → `401` with body `"virtual key required … set one of x-bf-vk, Authorization: Bearer <vk>, or x-api-key"` and **no `WWW-Authenticate` header**.
- With `x-bf-vk: <key>` → `200`, `initialize` succeeds.

Because there is no `WWW-Authenticate` header and no OAuth metadata endpoints, Desktop cannot discover an authorization server. It falls back to Dynamic Client Registration against a server that has no registration endpoint → `mcp_registration_failed`. Bifrost's own docs note it **intentionally does not implement an OAuth stub** for that DCR probe; the `/mcp` connection works fine once the client sends a virtual key — the failure is Desktop's inability to send one ([Bifrost MCP Gateway docs](https://docs.getbifrost.ai/mcp/gateway)).

**Key architectural fact:** Bifrost's documented OAuth features (`docs.getbifrost.ai/mcp/oauth`, per-user OAuth) are for Bifrost acting as an OAuth **client** to *upstream* MCP servers. They do **not** make Bifrost's own downstream `/mcp` endpoint an OAuth-protected resource. That downstream capability is what the OAuth path in this plan adds.

**Corollary:** The plugin cannot "add OAuth" at the gateway. It *can* ship a **local stdio→HTTP proxy config** for Desktop (Option 0) and document the full OAuth path once server-side work exists. Real OAuth must be implemented at the gateway (or a reverse proxy in front of it).

---

## 2. What the MCP authorization spec requires

The current MCP authorization spec classifies the MCP server as an **OAuth 2.1 resource server**. To be connectable by the desktop flow, the gateway (or a shim in front of it) must:

1. **Protected Resource Metadata (RFC 9728)** — serve `/.well-known/oauth-protected-resource` advertising the authorization server(s) and the resource identifier.
2. **`WWW-Authenticate` on 401** — unauthenticated requests must return `401` with `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
3. **Authorization Server Metadata (RFC 8414)** — `/.well-known/oauth-authorization-server` (from the AS), exposing `authorize`, `token`, and `registration`/`jwks` endpoints.
4. **Client registration** — support Dynamic Client Registration (RFC 7591) and/or Client ID Metadata Documents (the Nov-2025 preferred mechanism), or a documented pre-registered client ID path (the desktop error's "add an OAuth Client ID" fallback).
5. **PKCE (S256)** — mandatory for public clients like the desktop app.
6. **Token validation + audience binding** — validate the `Bearer` JWT (issuer, signature via JWKS, expiry, scopes) and bind the token audience to this resource (Resource Indicators, RFC 8707) to avoid token pass-through.

---

## 3. Approach options

### Option 0 — Local stdio→HTTP header proxy (recommended first step)

Claude Desktop only speaks **stdio** to local processes or **OAuth** to remote URLs — it cannot attach custom headers to a remote connector ([#112](https://github.com/anthropics/claude-ai-mcp/issues/112)). Anthropic's maintainer recommends running a **local stdio MCP server that proxies to the remote Bifrost URL and injects `x-bf-vk` on each outbound call** ([#120](https://github.com/anthropics/claude-ai-mcp/issues/120)).

| | |
|---|---|
| **What it is** | A local process (`mcp-remote`, `mcp-claude-bridge`, or similar) that Desktop launches via stdio; it forwards JSON-RPC to `${BIFROST_URL}` and adds the virtual-key header. |
| **Effort** | Low — no gateway changes, no authorization server, no stable-domain blocker. |
| **Plugin role** | Ship a documented `claude_desktop_config.json` snippet; optionally a small install helper. |

Example Desktop config (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${BIFROST_URL}",
        "--transport", "http-only",
        "--header", "x-bf-vk:${BIFROST_VK}"
      ],
      "env": {
        "BIFROST_URL": "https://<your-gateway-host>/mcp",
        "BIFROST_VK": "vk_<your-key>"
      }
    }
  }
}
```

**Note:** On Cursor and Claude Desktop (Windows), avoid spaces around `:` in `--header` args — use `"x-bf-vk:${BIFROST_VK}"` and put the value in `env` ([mcp-remote docs](https://www.npmjs.com/package/mcp-remote)).

**When to stop here:** If a one-time local-proxy setup per user is acceptable, Option 0 closes the task. Phases 1–7 below are only needed when **zero-config OAuth Connect** (no local Node/binary, direct remote URL in the connector UI) is a hard requirement.

---

| Option | What it is | Effort | Recommendation |
|---|---|---|---|
| **0. Local header proxy** | stdio→HTTP proxy injects `x-bf-vk`; gateway unchanged. | Low | **Recommended first** — Anthropic's documented workaround; plugin-shippable. |
| **A. OAuth-bridge proxy (sidecar)** | Reverse proxy in front of Bifrost implementing items 1–6 (§2), then injects mapped `x-bf-vk`. Bifrost unchanged. | Medium | Use when zero-config OAuth Connect is required and Option 0 is unacceptable. Prefer an **off-the-shelf MCP resource-server layer** (Keycloak/Ory, Auth0/Descope/Stytch/Cloudflare MCP templates) over hand-rolled JWT validation. |
| **B. Native Bifrost feature** | Add downstream resource-server support to Bifrost core (Go) and contribute upstream or fork. | High | Best long-term if maintained upstream; slower, ties you to fork maintenance. |
| **C. IdP-fronted only** | Point Desktop at the company IdP (Keycloak/Entra/Auth0) as the AS; still need a resource-server layer to validate tokens and map to a virtual key. | Medium | Use the IdP as the AS *within* Option A rather than as a standalone answer. |

The OAuth implementation phases (§5) assume **Option A**, with the company IdP (or an embedded AS such as Ory Hydra / Keycloak) serving as the authorization server. Substitute a native Bifrost implementation for Phases 2–4 if Option B is chosen.

---

## 4. Prerequisites & decisions to lock first

- **Decision gate (do this first):** Do you require **zero-config OAuth Connect** in the Desktop connector UI (remote URL, no local process), or is a **one-time local-proxy config per user** (Option 0) acceptable? If the latter, implement Option 0 and stop — Phases 1–7 are unnecessary.
- **Stable public hostname** *(OAuth path only).* `*.share.zrok.io` URLs are ephemeral. OAuth binds `redirect_uri`, the PRM `resource` identifier, and token `audience` to a fixed origin; Bifrost's own docs warn that a changed public URL invalidates a registered client ("Invalid redirect URI"). **Move the gateway to a stable domain** (e.g. `bifrost.luca-app.de`) before enabling OAuth. This is a hard blocker for Option A, not for Option 0.
- **Authorization server choice.** Reuse an existing luca/neXenio IdP if one exists (preferred — inherits SSO, MFA, user lifecycle), otherwise stand up Keycloak or Ory Hydra.
- **Identity → virtual key mapping.** Decide how an authenticated user maps to a Bifrost virtual key so governance (budgets, rate limits, tool groups) still applies: per-user VKs, a claim-to-VK lookup table, or a shared team VK keyed by an `mcp:*` scope.
- **Scope model.** Define OAuth scopes and how they map to Bifrost tool groups (e.g. `mcp:read`, `mcp:write`, or per-tool-group scopes).
- **DCR vs pre-registered client.** Confirm whether the AS supports RFC 7591 DCR (needed for zero-config desktop connect) or whether users must paste a pre-registered client ID.

---

## 5. Implementation phases

### Phase 1 — Authorization server
- Stand up / configure the AS (IdP, Keycloak, or Hydra) with OAuth 2.1 + PKCE (S256).
- Enable **Dynamic Client Registration** (RFC 7591) or Client ID Metadata Documents; if neither, document a pre-registered public client ID for the desktop app.
- Define scopes and consent screen; register the desktop redirect URIs (Claude desktop callback + localhost loopback range).
- Publish `/.well-known/oauth-authorization-server` and JWKS.

### Phase 2 — Protected Resource Metadata on the gateway edge
- Serve `/.well-known/oauth-protected-resource` (RFC 9728) with `resource` = the stable gateway origin and `authorization_servers` = the AS issuer.
- Change the unauthenticated `/mcp` response to `401` **with** `WWW-Authenticate: Bearer resource_metadata="…"`. (This single header is the difference between the desktop flow discovering OAuth vs. failing DCR.)

### Phase 3 — Token validation & virtual-key mapping (the bridge proxy)

Prefer an **off-the-shelf MCP resource-server / token validator** (Keycloak or Ory Hydra as AS + a thin mapping layer, or a managed template from Auth0, Descope, Stytch, Cloudflare, etc.) over hand-rolled JWT validation — token validation is the security-critical path and easy to get wrong.

The bridge (whether custom or composed from existing components) must, for each `/mcp` request:

1. Extract the `Authorization: Bearer` token.
2. Validate issuer, signature (AS JWKS), expiry, and **audience = this resource** (RFC 8707) — reject tokens minted for any other audience (prevents pass-through).
3. Check required scopes.
4. Resolve the caller identity/claims to a Bifrost **virtual key** via the mapping chosen in §4.
5. Inject `x-bf-vk: <resolved key>` and forward to the real Bifrost `/mcp`. Strip the inbound Bearer before forwarding.
6. Preserve the existing header path: if a request already carries a valid `x-bf-vk`/`x-api-key`, pass it straight through (keeps Claude Code CLI working unchanged).

### Phase 4 — Deployment
- Deploy the proxy in front of Bifrost on the stable domain; terminate TLS at the proxy.
- Wire routing: `/.well-known/*` and `/mcp` handled by the proxy; everything else forwarded.
- Set the bridge proxy's **issuer / PRM `resource` identifier** to the stable public origin so OAuth `redirect_uri` and token `aud` stay locked correctly.
- **`mcp_external_client_url` is a Bifrost setting**, not the bridge proxy's — it controls the `redirect_uri` Bifrost registers with *upstream* OAuth providers when using per-user OAuth. Only relevant if you also run Bifrost's lazy upstream OAuth; it does not configure downstream resource-server auth for Option A.

### Phase 5 — Plugin changes (`bifrost-plugin`)

**Important:** The plugin's `.mcp.json` configures **Claude Code only**. It does **not** drive the Claude Desktop connector. Desktop is configured separately in `claude_desktop_config.json` (Option 0) or via the connector's OAuth fields (Option A).

- **Option 0 (Desktop):** Add a documented `claude_desktop_config.json` snippet (see §3) to README, `bifrost-onboard`, and `bifrost-mcp-setup`. Keep `${BIFROST_VK}` in env, never in committed files.
- **Option A (Desktop OAuth):** Document connector setup on the stable domain with OAuth client ID/secret in Advanced settings; no changes to `.mcp.json` for Desktop.
- **`.mcp.json` (Claude Code):** Keep `${BIFROST_URL}` + `${BIFROST_VK}` header auth unchanged — CC already supports headers natively.
- **`README.md`**: broaden scope beyond "Claude Code only"; add an **Authentication modes** section — local proxy or OAuth for Desktop, virtual key for Claude Code CLI. Document the "add an OAuth Client ID in connector settings" fallback that matches the Desktop error text.
- **`skills/bifrost-onboard/SKILL.md`**: add Desktop setup (Option 0 first, OAuth as advanced) alongside the CLI header walkthrough.
- **`skills/bifrost-debug/SKILL.md`**: extend the decision tree — Desktop `mcp_registration_failed` → try Option 0 before OAuth buildout; OAuth failures (AS lacks DCR / no PRM / missing `WWW-Authenticate`), `Invalid redirect URI` (public URL changed), token audience/scope rejects, expired token.
- **`skills/bifrost-mcp-setup/SKILL.md`**: add Desktop `claude_desktop_config.json` proxy steps and manual OAuth client-ID entry for Option A.
- **`guidance/bifrost-context.md`**: note Desktop (proxy or OAuth) vs Claude Code (header) auth paths.
- Add any `BIFROST_OAUTH_*` env/config placeholders for Option A; keep `BIFROST_VK` for Option 0 and the CLI path.

### Phase 6 — Testing

**Option 0:**
- Desktop via `mcp-remote` / bridge: confirm `initialize` succeeds and tools list on a clean profile.
- Regression: Claude Code CLI header path still connects.

**Option A (OAuth):**
- Desktop connector: full DCR + PKCE connect on a clean profile; confirm `initialize` succeeds and tools list.
- Claude Code CLI: confirm the header path still connects (regression).
- Governance: confirm the mapped virtual key applies budgets/rate limits/tool-group filtering for OAuth callers.
- Token lifecycle: expiry → silent refresh; revocation → access denied.
- Redirect-URI lock: re-verify after any hostname change.

### Phase 7 — Security review
- PKCE S256 enforced; no implicit flow.
- Audience binding / Resource Indicators enforced; reject cross-audience tokens.
- Bearer never forwarded upstream; `x-bf-vk` never logged.
- Scope → tool-group least privilege.
- TLS everywhere; secrets in a vault, not files or git.
- Consider a subagent or external review of the token-validation path before rollout.

---

## 6. Key risks & edge cases

- **Desktop has no header field** — remote Connect always tries OAuth unless you use a local stdio proxy (Option 0). Do not assume `.mcp.json` or plugin config affects Desktop.
- **Ephemeral zrok URL** — breaks OAuth `redirect_uri`, PRM `resource`, and token audience (Option A only). Must move to a stable domain first. Option 0 is unaffected.
- **Local proxy credentials** — Option 0 stores `BIFROST_VK` in `claude_desktop_config.json` `env`; treat that file as a secret and lock down permissions.
- **AS without DCR** — desktop zero-config OAuth connect won't work; fall back to Client ID Metadata Documents or a documented pre-registered client ID.
- **Token pass-through anti-pattern** — without audience validation, a token for another service could be replayed at the gateway. Enforce RFC 8707.
- **Identity→VK mapping gap** — if an authenticated user has no mapped virtual key, define a safe default (deny, or a low-privilege VK) rather than falling open.
- **Dual auth confusion** — Desktop (proxy or OAuth) and Claude Code (header) use different config files; document both clearly.
- **Upstream drift (Option B)** — a Bifrost fork needs ongoing rebase; prefer contributing the resource-server feature upstream.

---

## 7. Recommended sequence (summary)

**Path A — Option 0 (most teams):**
1. Ship `claude_desktop_config.json` proxy snippet in plugin docs/skills.
2. Test Desktop connect + Claude Code CLI regression.
3. Done unless zero-config OAuth becomes a requirement.

**Path B — Full OAuth (zero-config Connect):**
1. Confirm zero-config OAuth Connect is a hard requirement (§4 decision gate).
2. Move the gateway to a stable HTTPS domain.
3. Choose/stand up the authorization server (prefer existing IdP) with PKCE + DCR.
4. Build the bridge proxy (prefer off-the-shelf resource-server): PRM + `WWW-Authenticate`, token validation with audience binding, identity→virtual-key mapping, `x-bf-vk` injection, header pass-through for CLI.
5. Deploy behind the stable domain.
6. Update plugin README and skills for Desktop OAuth + Claude Code header auth.
7. Test desktop OAuth + CLI header + governance + refresh/revoke.
8. Security review, then roll out.

---

## Sources

- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Client Registration in the Nov 2025 MCP Authorization spec — Aaron Parecki](https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update)
- [Diving Into the MCP Authorization Specification — Descope](https://www.descope.com/blog/post/mcp-auth-spec)
- [Bifrost MCP Gateway](https://docs.getbifrost.ai/mcp/gateway)
- [Bifrost MCP Auth Overview](https://docs.getbifrost.ai/mcp/auth/overview)
- [Bifrost Per-User OAuth](https://docs.getbifrost.ai/mcp/auth/per-user-oauth)
- [Bifrost OAuth 2.0 Authentication (upstream)](https://docs.getbifrost.ai/mcp/oauth)
- [maximhq/bifrost (GitHub)](https://github.com/maximhq/bifrost)
- [anthropics/claude-ai-mcp#112 — no Bearer/header field for remote connectors](https://github.com/anthropics/claude-ai-mcp/issues/112)
- [anthropics/claude-ai-mcp#120 — local stdio proxy workaround (maintainer recommendation)](https://github.com/anthropics/claude-ai-mcp/issues/120)
- [anthropics/claude-ai-mcp#10 — tracking issue for custom header / static credential auth](https://github.com/anthropics/claude-ai-mcp/issues/10)
- [mcp-remote (npm)](https://www.npmjs.com/package/mcp-remote)
