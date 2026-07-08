# Keycloak Runbook — Authorization Server for the Bifrost OAuth Bridge

Configure the company Keycloak so Claude Desktop can register dynamically (RFC 7591),
authenticate users with PKCE S256, and mint tokens the bridge accepts (issuer +
audience + scope). All steps are Keycloak admin work; nothing here touches the
bridge code.

Placeholders used below — substitute your real values:

- `<kc>` — Keycloak base URL, e.g. `https://keycloak.luca-app.de`
- `<origin>` — the bridge's stable public origin, e.g. `https://bifrost.luca-app.de`
  (must equal the bridge's `BRIDGE_PUBLIC_ORIGIN` exactly)

## 1. Realm

Create a dedicated realm `mcp` (recommended — keeps the anonymous-DCR policies
isolated from other company clients), or reuse an existing realm after reviewing
its client-registration policies with the IdP owner.

Federate users from the existing user store (LDAP/SSO broker) or create them
directly, so engineers log in with their normal company identity. The bridge maps
users by the `email` claim, so make sure emails are populated and verified.

Set the bridge env `KEYCLOAK_ISSUER=<kc>/realms/mcp`.

## 2. Client scopes + audience mapper

1. **Client scopes** → create `mcp:read` and `mcp:write` (type: optional or
   default — default is simplest for zero-config connect; the bridge requires
   `mcp:read` out of the box, matching its `BRIDGE_REQUIRED_SCOPE`).
2. On each scope add a **mapper** → *By configuration* → **Audience**:
   - Included Custom Audience: `<origin>`
   - Add to access token: **on**

   This is what makes tokens carry `aud: <origin>` — without it the bridge
   rejects every token (RFC 8707 audience binding).

## 3. Dynamic Client Registration (anonymous) with guardrails

Claude Desktop registers itself on first connect, so anonymous DCR must be open —
but constrained by client-registration policies (Realm settings → **Client
registration** → *Client registration policies* → **Anonymous access policies**):

1. **Trusted Hosts** policy: add Anthropic's client hosts (at minimum
   `claude.ai`); enable *Host Sending Client Registration Request Must Match*
   only if your network setup preserves client IPs — otherwise rely on the
   redirect-URI constraint below.
2. **Consent Required** policy: on — users see what they are granting.
3. **Allowed Client Scopes**: restrict to `mcp:read`, `mcp:write` (plus
   `openid`, `email`, `profile`).
4. **Redirect URIs** (via the *Allowed redirect URI patterns* / trusted-hosts
   configuration): allow only
   - `https://claude.ai/api/mcp/auth_callback`
   - `http://127.0.0.1:*` and `http://localhost:*` (Desktop loopback callback)

   > Verify the exact Desktop callback at rollout time by inspecting the
   > `redirect_uris` in the client that DCR creates on a first test connect.
5. Leave **Max Clients** at a sane bound (default 200) and periodically prune
   auto-registered clients (Clients list → filter by dynamic registration).

## 4. PKCE S256 + no implicit flow

Realm settings → **Client policies**:

- Create a policy matching all clients created by the anonymous DCR endpoint
  (condition: *client-updater-source-roles* = anonymous, or match-all).
- Attach the **`pkce-enforcer`** executor with *Auto-configure* on — every
  DCR-registered client is forced to Authorization Code + PKCE **S256**.

Also confirm realm-wide: implicit flow disabled on the registered clients
(the pkce-enforcer + standard-flow default covers this).

## 5. Sessions & token lifetimes

Realm settings → Sessions/Tokens:

- Access token lifespan: short (5–15 min) — the bridge validates `exp` on every request.
- SSO session / refresh: enabled with your normal company policy, so Desktop
  silently refreshes instead of re-prompting.
- Revocation: revoking a user session in Keycloak ends gateway access at the
  next token expiry; for immediate cut-off also remove the user's VK-map entry.

## 6. Verify the AS metadata

```bash
curl -s <kc>/realms/mcp/.well-known/oauth-authorization-server | jq '{
  issuer,
  registration_endpoint,
  code_challenge_methods_supported,
  authorization_endpoint,
  token_endpoint
}'
```

Must show a `registration_endpoint` (DCR live) and `S256` in
`code_challenge_methods_supported`. If `registration_endpoint` is missing,
anonymous client registration is not enabled (step 3).

## 7. Test client (for minting test tokens)

Create a confidential client `bridge-test` (service accounts **off**, direct
access grants **on**, default scopes `mcp:read` + `email`) to mint real user
tokens in integration tests:

```bash
curl -s -X POST '<kc>/realms/mcp/protocol/openid-connect/token' \
  -d grant_type=password \
  -d client_id=bridge-test -d client_secret=$BRIDGE_TEST_SECRET \
  -d username=<test-user> -d password=$TEST_USER_PASSWORD \
  -d scope='openid email mcp:read' | jq -r .access_token
```

Use it to drive the §Verify checks in the bridge README: valid token → 200;
token minted without the `mcp:read` scope → 403; token from another realm/client
without the audience mapper → 401; test user missing from the VK map → 403
`no_virtual_key`. Keep `bridge-test` disabled outside test windows.
