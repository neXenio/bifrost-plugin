# Changelog

All notable changes to bifrost-plugin are documented here.

## [Unreleased]

## [1.2.0] — 2026-07-18

Remediation release: removes every hook side effect that organization plugin
review flags, so the plugin can pass marketplace import screening. Auth is
unchanged (`x-bf-vk` header, `BIFROST_URL`/`BIFROST_VK` env).

### Backward compatibility

Pinned by the contract tests in `test/compat.test.cjs` (`npm test`):

- **Gateway-side clients are untouched.** Nothing in this release changes the
  gateway; clients using the gateway's OpenAI-compatible endpoint (or any
  other route) with existing `vk_…` keys are unaffected.
- **Plugin wire format is unchanged**: same server name (`bifrost`), same
  transport (`http`), same `${BIFROST_URL}`/`${BIFROST_VK}` templates, same
  `x-bf-vk` auth header. `.mcp.json` is byte-identical to v1.1.0.
- **Hook surface unchanged**: still exactly `SessionStart` +
  `UserPromptSubmit`; all existing injection switches
  (`BIFROST_MEMORY_INJECT`, `BIFROST_SKILLS_INJECT`, `BIFROST_KB_INJECT`)
  and sizing knobs keep working; pre-1.1.0 plain-string cache files still
  render.
- **Installer flags unchanged**: `--key`, `--dry-run`, `--help`. New
  requirement: `BIFROST_URL` must be set (it errors loudly instead of writing
  a template to a dead file).
- **One deliberate tightening**: hooks no longer send the key over cleartext
  HTTP to non-loopback hosts. Legacy private-network deployments on plain
  HTTP must set `BIFROST_ALLOW_HTTP=1` to restore the old behavior.
- Setting the removed `BIFROST_DEV_SYNC` / `BIFROST_AUTOSETUP` vars is now a
  harmless no-op.

### Changed

- **SessionStart hook no longer has side effects beyond its own cache.** It
  emits cached context and (at most once per hour, configurable via
  `BIFROST_REFRESH_INTERVAL_MS`) spawns the detached gateway refresh. New
  master kill switch `BIFROST_REFRESH=0` disables all session-start-initiated
  network traffic. The refresh query contains only the project directory
  basename plus a fixed recall phrase.
- **Onboarding is explicit-only.** The SSO browser flow (`hooks/auto-setup.cjs`,
  gated on `BIFROST_KEYAPP_URL`) now runs only when the user invokes
  `/bifrost-setup`. No hook opens a browser or writes configuration.
- **`bin/install.js` no longer edits config files.** It is a thin wrapper over
  `claude mcp add --scope user` — Claude Code's own config writer. The previous
  target (`~/.claude/mcp.json`) was not a file Claude Code reads.
- **Gateway client refuses cleartext key transport.** `hooks/lib/gateway.cjs`
  only sends the `x-bf-vk` header over HTTPS (plain HTTP allowed to loopback
  for local dev gateways).
- **Manifest slimmed to schema-guaranteed fields.** `plugin.json` drops the
  redundant `skills`/`commands` arrays (both directories are auto-discovered)
  and `defaultEnabled`, which moves to the marketplace plugin entry (the
  documented precedence location and the only one present in the published
  schemas). `marketplace.json` gains the top-level `description` that
  `claude plugin validate --strict` requires.
- All four `commands/*.md` gained YAML frontmatter (`description:`), fixing
  `claude plugin validate --strict` failures.

### Removed

- `hooks/session-start.cjs` dev-cache "self-heal" (`BIFROST_DEV_SYNC`) and
  `scripts/sync-plugin-cache.sh` — a hook must not rewrite Claude Code's
  `installed_plugins.json` or re-point the plugin cache.
- SessionStart auto-spawn of the onboarding worker (`BIFROST_AUTOSETUP`).
- `scripts/settings-lint.sh`, `docs/settings-policy.md`,
  `hooks/HOOK-VERIFICATION.md` — dev tooling that the v1.1.0 changelog already
  declared removed but that still shipped; now actually gone.

## [1.1.0] — 2026-07-09

### Changed

- **Adaptive memory/KB injection sizing.** `hooks/refresh.cjs` no longer
  applies a flat fact cap and snippet length: it fetches a wider candidate
  pool from `memory_search` (parsed as structured JSON with
  content/similarity, not just regex-scraped text), then greedily fills a
  character budget from the most similar results, giving higher-similarity
  facts a larger snippet allowance. New knobs: `BIFROST_MEMORY_MAX_FACTS`,
  `BIFROST_MEMORY_SNIPPET_LEN`, `BIFROST_INJECT_BUDGET`,
  `BIFROST_MEMORY_MIN_SIM`. Falls back to the original flat-cap behavior
  when the response isn't parseable structured JSON, so recall never
  regresses on an older gateway. `session-start.cjs`'s `emitMemory`/`emitKb`
  now handle both the new `{content, similarity}` fact shape and the old
  plain-string shape (stale caches keep working through the upgrade).
  `BIFROST_MEMORY_FAST=1` opts into passing `fast:true` to `memory_search`
  (server-side fast path) once the gateway ships it; off by default since an
  unrecognized param could reject the call on a strict schema.

### Added

- **Knowledgebase auto-injection.** `hooks/refresh.cjs` now also queries the
  KB wing (`memory_search` with `wing=<BIFROST_KB_WING>`, no default — KB
  recall is skipped entirely unless `BIFROST_KB_WING` is set, plus
  `BIFROST_KB_QUERY`) and caches it alongside memory. `session-start.cjs`
  gained `emitKb()`, wired next to `emitSkills`/`emitMemory`, disable with
  `BIFROST_KB_INJECT=0`. There is no separate KB MCP server — KB recall goes
  through the same memory server as memory recall, just scoped to a
  different wing. Additive, ships `defaultEnabled: false`.
- `hooks/auto-setup.cjs` — one-command onboarding worker (loopback SSO
  callback → `claude mcp add`), reviewed and landed. No default keyapp/gateway
  URL is assumed — it's a no-op unless the gateway operator sets
  `BIFROST_KEYAPP_URL` (and `BIFROST_URL`) for their own deployment.

### Removed

- `mcpServers` pointer from `.claude-plugin/plugin.json` — the root
  `.mcp.json` is auto-discovered by Claude Code, so the pointer was
  redundant.

> Correction (1.2.0): this release's original notes also listed
> `scripts/sync-plugin-cache.sh`, `scripts/settings-lint.sh`,
> `docs/settings-policy.md`, and `hooks/HOOK-VERIFICATION.md` as removed, but
> they still shipped in 1.1.0. They were actually removed in 1.2.0.

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
