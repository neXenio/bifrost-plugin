# Changelog

All notable changes to bifrost-plugin are documented here.

## [0.1.0] — 2026-06-29

Initial release — Claude Code scope only.

### Added

- `.claude-plugin/plugin.json` — CC plugin manifest (name, version, skills, hooks, mcpServers, commands)
- `.claude-plugin/marketplace.json` — single-plugin marketplace catalog
- `.mcp.json` — plugin-scoped MCP declaration for the Bifrost gateway (`url: ${BIFROST_URL}`, `x-bf-vk: ${BIFROST_VK}`)
- `bin/install.js` — idempotent installer: merges bifrost MCP entry into `~/.claude/mcp.json`; aborts on malformed JSON; backs up existing file to `mcp.json.bak`; writes atomically (tmp + rename); `--key` flag prints export reminder without writing the key to disk; `--dry-run` support; gateway URL from `BIFROST_URL` env. No `postinstall` hook — the installer is always run explicitly.
- `commands/bifrost-setup.md`, `commands/bifrost-onboard.md`, `commands/bifrost-debug.md`, `commands/bifrost-mcp-setup.md` — slash commands that load the matching skill
- `hooks/hooks.json` — hook registrations: `SessionStart`, `UserPromptSubmit`, `Stop`
- `hooks/session-start.cjs` — emits `guidance/bifrost-context.md` (~400 tokens) at session start, then drains `~/.cache/bifrost-plugin/staging/`: POSTs any distilled `facts[]` to the memory service `POST ${BIFROST_MEMORY_URL}/memory/store` and moves files to `processed/` (caps `processed/` + `reflected/` to the last 50). Consumer side of the Pillar-4 flywheel
- `hooks/prompt-submit.cjs` — memory enrichment (similarity >= 0.5, 600-char cap), auto-skipped when the global `~/.memory` hook is active; word-boundary task-verb skill-discovery hint emitting `mcp__bifrost__<skills-server>-skill_search` (server name from `BIFROST_SKILLS_SERVER`, default `skills`), suppressed when `BIFROST_VK` is unset; injected memory wrapped in a reference-DATA boundary
- `hooks/session-reflect.cjs` — Stop hook: stages session learnings to `~/.cache/bifrost-plugin/staging/` (file I/O only, no network on exit); rate-limited one-per-session via marker file; the next SessionStart ingests them. The memory service applies its own noise + dedup gate
- `skills/bifrost-onboard/SKILL.md` — onboarding skill
- `skills/bifrost-debug/SKILL.md` — diagnosis skill
- `skills/bifrost-mcp-setup/SKILL.md` — manual MCP wiring fallback skill
- `guidance/bifrost-context.md` — ~400-token session-start payload
- `guidance/AGENTS-skill-stanza.md` — canonical skill-discovery MUST-stanza for CLAUDE.md/AGENTS.md
- `README.md`, `INSTALL.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `package.json`

### Configuration

- `BIFROST_URL` — gateway `/mcp` endpoint (defaults to a documented placeholder)
- `BIFROST_VK` — virtual key for the `x-bf-vk` auth header
- `BIFROST_MEMORY_URL` — memory service base URL (default `http://127.0.0.1:52421`)
- `BIFROST_SKILLS_SERVER` — name of the gateway's skill server (default `skills`)

### Security

- Zero literal key values anywhere in the repo
- `${BIFROST_VK}` is the only form the VK ever takes in files
- `.gitignore` blocks `.env`, `*.key`, `*_VK=*`

### Out of scope (deferred to v2)

- Cursor, Codex, Antigravity, Augment manifests
- Universal gateway `PreRequestHook` plugin (server-side, per-model-request injection)
- `bifrost-skill-router` internal skill
