# Changelog

All notable changes to bifrost-plugin are documented here.

## [1.1.0] — 2026-07-07

### Added — Claude Desktop support via OAuth (zero-config Connect)

- **`bridge/` — OAuth 2.1 resource-server bridge** (new subproject, Node 20 +
  Fastify + `jose`): makes the gateway's `/mcp` endpoint connectable from Claude
  Desktop's connector UI, fixing `mcp_registration_failed`.
  - RFC 9728 Protected Resource Metadata at
    `/.well-known/oauth-protected-resource` (+ `/mcp` variant) and
    `WWW-Authenticate: Bearer resource_metadata="…"` on unauthenticated 401s.
  - Keycloak token validation: issuer, signature (remote JWKS), expiry,
    **audience binding** (RFC 8707 — cross-audience tokens rejected), required
    scope (`mcp:read` by default).
  - Per-user **claim→virtual-key mapping** (`email` then `sub`,
    case-insensitive), deny-by-default for unmapped users; Bearer stripped
    before forwarding; VK/token headers redacted from logs.
  - **VK-map sync job** (`bridge/src/sync-vk-map.mjs`, `npm run sync`): periodic
    export of Bifrost's SSO-provisioned user→VK table
    (`GET /api/governance/virtual-keys` with an admin token) into `vk-map.json`
    — Bifrost stays the single source of truth, no hand-maintained mapping, and
    the admin credential never sits in the request path. Atomic writes,
    change-detection, empty-result guard, `--dry-run`, one-shot (cron) or
    interval (compose `vk-sync` sidecar) modes, field-path overrides for
    response-shape differences (`VK_SYNC_EMAIL_PATH` / `VK_SYNC_VALUE_PATH`).
  - `x-bf-vk` / `x-api-key` passthrough — the Claude Code CLI header path is
    untouched.
  - Dockerfile + Caddy→bridge→Bifrost compose example; 20 unit tests
    (`npm test`); Keycloak realm runbook (`bridge/docs/keycloak-setup.md`:
    DCR policies, PKCE S256 enforcement, audience mapper, test client).
- **Docs & skills:** README *Authentication modes* section (Desktop OAuth,
  Desktop `mcp-remote` fallback, CLI header); `bifrost-onboard` step 6 (Desktop
  connect); `bifrost-debug` step 7 (Desktop/OAuth decision tree + new symptom
  rows); `bifrost-mcp-setup` Claude Desktop section; auth-mode notes in
  `guidance/bifrost-context.md` and `guidance/bifrost-guide.md`.

### Unchanged

- `.mcp.json` / `bin/install.js` — Claude Code wiring and header auth as before.

## [1.0.1] — 2026-07-06

### Fixed

- Remove explicit `hooks` field from `plugin.json` — Claude Code auto-loads
  `hooks/hooks.json`; declaring it caused a duplicate-hooks `/doctor` error.
- `bin/install.js` writes `${BIFROST_URL}` (runtime template) into
  `~/.claude/mcp.json`, matching `.mcp.json`, the VK header, and the README —
  instead of snapshotting the URL at install time.

## [1.0.0] — 2026-07-01

### Distribution-ready

- **Non-blocking session start.** The SessionStart hook does zero synchronous
  network I/O — it injects the skill-library primer and recalled-memory header
  from a per-project cache (sub-ms) and refreshes the cache via a detached
  background worker (`hooks/refresh.cjs`). A slow or unreachable gateway adds
  ~0ms to startup (measured 0.04s with a dead gateway). Replaces the earlier
  `memory-refresh.cjs`, which only cached memory.
- **Self-wiring via shipped `.mcp.json`** (env placeholders) + `defaultEnabled:
  false`, so the marketplace install is the primary path; `bin/install.js` is a
  fallback. See `DISTRIBUTION.md` for the fleet rollout guide and the gateway
  prerequisites that gate a large rollout.
- README install rewritten to the 3-step marketplace path.

## [0.2.0] — 2026-06-29

### Changed — memory is now agent-driven via MCP (pull-only)

Memory is no longer injected automatically by hooks. The agent now uses the
gateway's memory MCP tools directly — no local HTTP memory service required.

- **Removed** `hooks/session-reflect.cjs` — Stop hook that staged session
  learnings to `~/.cache/bifrost-plugin/staging/` for HTTP write to the memory
  service. Session reflection is now agent-driven: save decisions with the
  gateway's memory store tool after significant work.
- **Removed** Job A from `hooks/prompt-submit.cjs` — the per-prompt memory
  enrichment via direct HTTP call to the memory service's context endpoint.
  Memory recall is now agent-driven: call the gateway's memory search tool
  before non-trivial tasks.
- **Removed** staging drain from `hooks/session-start.cjs` — the SessionStart
  hook no longer POSTs staged facts to the memory service write route. It now
  only emits `guidance/bifrost-context.md` and exits.
- **Removed** `Stop` hook from `hooks/hooks.json`. Only `SessionStart` and
  `UserPromptSubmit` remain.
- **Removed** the memory-service base-URL env var (introduced in v0.1.0) — no
  direct-HTTP memory access remains anywhere in the plugin. No local memory
  service is required.
- **Removed** `~/.cache/bifrost-plugin/` staging/processed/reflected directory
  logic entirely.
- **Updated** `AGENTS.md`, `guidance/AGENTS-skill-stanza.md`,
  `guidance/bifrost-context.md` — added Memory section instructing the agent to
  call the gateway's memory search tool before non-trivial tasks and the memory
  store tool after significant work.
- **Updated** `guidance/bifrost-guide.md`, `README.md`, `INSTALL.md`,
  `commands/bifrost-setup.md`, `skills/bifrost-onboard/SKILL.md`,
  `skills/bifrost-debug/SKILL.md` — removed all references to the local memory
  service, the per-prompt auto-injection, and the session-reflection flywheel.
  Docs now describe the agent-driven MCP memory model.

### Why

Direct-HTTP memory access tightly coupled the plugin to a specific local service
on a fixed port. MCP-based memory is more flexible, works with any gateway-
exposed memory server, and keeps the agent in control of when to recall and save.

---

## [0.1.0] — 2026-06-29

Initial release — Claude Code scope only.

### Added

- `.claude-plugin/plugin.json` — CC plugin manifest (name, version, skills, hooks, mcpServers, commands)
- `.claude-plugin/marketplace.json` — single-plugin marketplace catalog
- `.mcp.json` — plugin-scoped MCP declaration for the Bifrost gateway (`url: ${BIFROST_URL}`, `x-bf-vk: ${BIFROST_VK}`)
- `bin/install.js` — idempotent installer: merges bifrost MCP entry into `~/.claude/mcp.json`; aborts on malformed JSON; backs up existing file to `mcp.json.bak`; writes atomically (tmp + rename); `--key` flag prints export reminder without writing the key to disk; `--dry-run` support; gateway URL from `BIFROST_URL` env. No `postinstall` hook — the installer is always run explicitly.
- `commands/bifrost-setup.md`, `commands/bifrost-onboard.md`, `commands/bifrost-debug.md`, `commands/bifrost-mcp-setup.md` — slash commands that load the matching skill
- `hooks/hooks.json` — hook registrations: `SessionStart`, `UserPromptSubmit`, `Stop`
- `hooks/session-start.cjs` — emits `guidance/bifrost-context.md` at session start, then drains a staging directory by POSTing distilled facts to the memory service write route and moving files to `processed/`. Consumer side of the Pillar-4 flywheel.
- `hooks/prompt-submit.cjs` — memory enrichment (similarity-filtered, capped), auto-skipped when the global `~/.memory` hook is active; word-boundary task-verb skill-discovery hint, suppressed when `BIFROST_VK` is unset; injected memory wrapped in a reference-DATA boundary
- `hooks/session-reflect.cjs` — Stop hook: stages session learnings to a local cache dir (file I/O only, no network on exit); rate-limited one-per-session via marker file; the next SessionStart ingests them
- `skills/bifrost-onboard/SKILL.md` — onboarding skill
- `skills/bifrost-debug/SKILL.md` — diagnosis skill
- `skills/bifrost-mcp-setup/SKILL.md` — manual MCP wiring fallback skill
- `guidance/bifrost-context.md` — session-start payload
- `guidance/AGENTS-skill-stanza.md` — canonical skill-discovery MUST-stanza for CLAUDE.md/AGENTS.md
- `README.md`, `INSTALL.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `package.json`

### Configuration (v0.1.0)

- `BIFROST_URL` — gateway `/mcp` endpoint (defaults to a documented placeholder)
- `BIFROST_VK` — virtual key for the `x-bf-vk` auth header
- Memory-service base URL env var (local HTTP memory service, deprecated in v0.2.0)
- `BIFROST_SKILLS_SERVER` — name of the gateway's skill server (default `skills`)

### Security

- Zero literal key values anywhere in the repo
- `${BIFROST_VK}` is the only form the VK ever takes in files
- `.gitignore` blocks `.env`, `*.key`, `*_VK=*`

### Out of scope (deferred to v2)

- Cursor, Codex, Antigravity, Augment manifests
- Universal gateway `PreRequestHook` plugin (server-side, per-model-request injection)
- `bifrost-skill-router` internal skill
