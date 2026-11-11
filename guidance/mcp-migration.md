# MCP transport migration plan

Assessment: 2026-11-11. **Plan only; the hook client remains on 2025-06-18.**
The dated 2026-07-28 specification is the migration target, not evidence that the
private gateway supports it. Do not change a version string independently of
transport behavior. The host application's MCP client is separate from the
small HTTP client used by plugin hooks.
## Compatibility matrix

| Server behavior | Current hook client | Required migration evidence |
|---|---|---|
| 2025-06-18 initialize/initialized, optional session ID | Implemented; local lifecycle/SSE fixtures cover it | Retain regressions, timeout budgets and silent-fail behavior |
| 2025-11-25 legacy lifecycle | Not selected by current client | Test explicit version support and applicable schema/error differences |
| 2026-07-28 stateless requests | Not implemented or proven against private gateway | New discovery, metadata and response fixtures plus authorized read-only gateway proof |
| Mixed-era gateway | Unknown | Test documented era detection and version rejection; no blind replay of tool calls |
| Unsupported version / capability | Fail closed | No private result, cache refresh or mutating retry on mismatch |
## Changes to evaluate

The [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
replaces initialization and sessions with per-request metadata and `server/discover`.
It introduces `resultType`, multi-round-trip input requests, subscriptions, cache
hints, method/name headers, and removes SSE resumability. It also moves tasks to
an extension, changes logging and roots notifications, broadens JSON schemas and
structured results, and revises OAuth issuer/client registration and error codes.
Trace propagation and deterministic tool ordering need review too.

For HTTP, implement the [transport binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
and [version compatibility rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
not a hybrid of new request metadata with legacy session headers. A closed stream
must not cause automatic replay of a tool with unknown side effects.

The intermediate [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
also matters: authorization discovery/consent, URL elicitation, sampling tools,
experimental tasks, schema dialect, validation errors, and SSE polling changed.
Icons and implementation descriptions are metadata; unsupported optional features
must not be advertised simply because a newer version is selected.
## Acceptance fixtures before implementation is enabled

1. Explicit old/new era selection; unsupported-version error; missing required
   capability; method/name header and body agreement. Capture the selected version
   immutably with endpoint and credential for each operation.
2. Legacy initialize/session behavior remains intact. Modern results distinguish
   complete from input-required; unsupported input requests stop quietly rather
   than being rendered as facts or approved automatically.
3. JSON and SSE matching IDs, terminal errors, split UTF-8/line endings, bounded
   parsing and independent deadlines. Disconnect/retry tests must prove no silent
   duplicate execution; use pure fixture tools only.
4. Structured and text results, `isError`, schema composition/reference limits,
   pagination and cache freshness. Protocol `cacheScope` values must not replace
   the plugin's credential identity digest: public server metadata does not grant
   permission to reuse private recalled context across keys.
5. Credential rotation, no-key behavior, late writes and detached refresh binding
   retain current isolation. New subscription/task/input features remain disabled
   until explicitly implemented and tested.
## Rollout gates and rollback

- Record exact gateway build and advertised versions using authorized non-mutating
  discovery. A public Bifrost release tag does not identify a private deployment.
- Select an explicit supported client/server pair; run only focused fixtures locally
  and the broad suite in CI. Record host/client versions and fixture hashes.
- Pilot read-only discovery/recall with no automatic retry of arbitrary tools.
  Verify every hook still exits 0 and never exposes credentials or protocol errors.
- Keep the legacy transport path available until pilot evidence supports removal.
  Roll back to the existing client on incompatibility; do not merge modern cache
  data into legacy identities without a separately reviewed migration.

Status: documentation complete; protocol implementation, gateway compatibility,
modern fixtures, CI and rollout remain open.
## Separate dependency: keyapp callback (U05)

`hooks/auto-setup.cjs:148` currently accepts a virtual key in the callback query.
This repository contains the loopback client, not the keyapp server or a one-time
code exchange endpoint. U05 remains blocked on an agreed server/client contract.
Proposed contract: an unpredictable, short-lived, single-use code bound to the
sign-in, exact loopback redirect, state and PKCE challenge; authenticated HTTPS
exchange with verifier validation and atomic consumption; reject expiry, replay,
wrong verifier, redirect or endpoint. Return the key only in the exchange body,
never a browser URL, logs or redirect. Bind the saved key to the captured gateway,
which may differ from the keyapp endpoint. Test refusal and replay races before
removing the old callback contract; do not silently accept both indefinitely.
These are proposed acceptance requirements, not an implemented OAuth flow.
See [native-app PKCE and loopback guidance](https://www.rfc-editor.org/rfc/rfc8252)
and [OAuth security best practices](https://www.rfc-editor.org/rfc/rfc9700).
