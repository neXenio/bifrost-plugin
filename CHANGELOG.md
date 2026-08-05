# Changelog

All notable changes to bifrost-plugin are documented here.

## [1.6.0] — 2026-08-05

### Added

- **`bifrost-gateway-essentials` skill.** The SessionStart hook injects a
  gateway-specific context block, but hooks run only in the Claude Code CLI and
  in Claude Desktop's Code and Cowork tabs — Desktop's Chat tab and claude.ai web
  get nothing. Skill descriptions are loaded on every surface whether or not the
  skill is invoked, so this skill's description carries the core operating rules,
  chiefly that a missing `mcp__bifrost__<server>-<tool>` usually means the
  capability sits in code mode behind `executeToolCode` rather than being absent.
  A partial substitute, not an equal one: a static description cannot name the
  servers your gateway actually exposes, and the gateway's own MCP tool
  descriptions are served by the upstream MCP servers, which this plugin does not
  control.
- **Documented how to pre-approve the gateway's tools.** New README section with
  the `permissions.allow` block for `~/.claude/settings.json`, covering both
  server names (`mcp__plugin_bifrost-plugin_bifrost` for the plugin install,
  `mcp__bifrost` for the project-MCP install) and the managed-settings variant for
  fleets. Also added to the `bifrost-debug` symptom map.

### Fixed

- **Corrected the `defaultEnabled` documentation.** README and DISTRIBUTION.md
  both stated the plugin "ships disabled (`defaultEnabled: false`)", while
  `marketplace.json` has carried `defaultEnabled: true` since 2026-07-24 (commit
  `2f66736`) across six releases. The manifest is the intended behaviour and the
  docs were wrong. What gates a connection is the virtual key, not the enable
  flag: an install with the key left blank is inert. DISTRIBUTION.md's rollback
  guidance was rewritten accordingly — unpublishing the marketplace entry stops
  new installs but does not disable existing ones. Also corrected DISTRIBUTION.md's
  two stale version numbers (v1.2.0 in the header, v1.0.0 in go/no-go) and its
  claim that `.mcp.json` still uses `${BIFROST_URL}` / `${BIFROST_VK}` env
  placeholders, which 1.5.0 replaced with `userConfig` templates.

### Notes

- A plugin **cannot** ship permission rules. `.claude-plugin/plugin.json` accepts
  a `settings` record and `claude plugin validate --strict` passes a `permissions`
  block inside it, but the loader picks only `agent` and `subagentStatusLine` and
  silently drops everything else — so such a block looks applied and is not.
  Verified against Claude Code 2.1.222. Pre-approval therefore stays a manual step
  on the user's side, which is also the right boundary.

## [1.5.0] — 2026-08-04

### Added

- **Claude Desktop plugin installability.** Claude Desktop has no shell
  environment. `.mcp.json` used `${BIFROST_URL}` and `${BIFROST_VK}`, and
  Claude Code's documented behaviour for an unset variable with no default
  is to load the config anyway and pass the unexpanded `${VAR}` text
  through as the literal value. A Desktop install therefore produced an
  MCP server whose URL was the literal string `${BIFROST_URL}` and whose
  `x-bf-vk` header was the literal string `${BIFROST_VK}`. It could never
  connect. Until now the Desktop story in the docs was a manual custom
  connector or an `mcp-remote` proxy, and both bypass the plugin entirely.

  `.claude-plugin/plugin.json` now declares a `userConfig` block. Two of
  its three options carry the connection itself: `gateway_url` (string,
  defaults to `https://bifrost.culture4.life/mcp`) and `virtual_key`
  (string, marked `sensitive: true`, no default). Claude prompts for both
  when the plugin is enabled, on every surface, so no shell profile is
  required. `.mcp.json` reads `${user_config.gateway_url}` and
  `${user_config.virtual_key}` in place of the environment variables.
  That substitution works in `headers`, which is not shell-parsed; Claude
  rejects `${user_config.*}` in shell-parsed fields such as hook commands
  and `headersHelper`.

  Verified against a live gateway, using a real plugin install in an
  isolated config directory with no shell environment at all: supplying a
  virtual key alone reaches "Connected".

- **`hooks/lib/gateway.cjs` gained a third credential source.** Claude
  exports every `userConfig` option to hook processes as
  `CLAUDE_PLUGIN_OPTION_<KEY>`. The hooks now resolve
  `CLAUDE_PLUGIN_OPTION_GATEWAY_URL` and `CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY`
  after the `BIFROST_URL`/`BIFROST_VK` environment pair and before the
  `~/.claude.json` scan. The rule that the URL and the key must come from
  the same source, never one of each, still holds for the new source.

### Changed

- Memory-write guidance now follows luca-memory v0.40: `subject`, `valid_from`, and
  `text`/`body` are the structured-claim contract; the removed `tenant` input is a
  hidden compatibility shim, not a value agents should invent. Collective writes now
  explain the server-side `pending` candidate result alongside local queued-ingest
  responses.
- `bifrost-debug` now diagnoses stale gateway tool catalogs after an upstream MCP
  upgrade and distinguishes catalog refresh from client/transport reconnects.

### Fixed

- Structured memory provenance objects are rendered with their useful `subject`,
  `wing`, `room`, and `created_at` fields instead of injecting `[object Object]` into
  SessionStart.

- **The manifest's "OAuth 2.1 for Desktop" claim, live since 1.3.0,
  described a flow no client could actually complete.** Without a virtual
  key, the MCP client falls back to dynamic client registration against
  the gateway's own auth-server metadata, and that document has never
  advertised a `registration_endpoint`. The attempt has always reached
  the same wall: "Incompatible auth server: does not support dynamic
  client registration".

  `.mcp.json` now carries an `oauth` block that points discovery at
  Keycloak directly: `authServerMetadataUrl` is
  `https://idms.nexenio.com/realms/nexenio/.well-known/openid-configuration`,
  which does advertise a `registration_endpoint`, and a third
  `userConfig` option, `oauth_client_id` (string, no default), feeds
  `oauth.clientId`. Pointing discovery at Keycloak gets one step further,
  then meets the realm's own gate: "Policy 'Trusted Hosts' rejected
  request to client-registration service. Details: Host not trusted."
  Supplying an `oauth.clientId` skips registration entirely and reaches
  "Needs authentication", the healthy pre-login state.

  This closes the plugin's half of the gap. What remains is an
  identity-provider change: either the Keycloak realm's Trusted Hosts
  policy is opened to loopback client registration, or an operator
  pre-registers a public client with redirect URI
  `http://localhost:51789/callback` and hands out that client ID for
  users to paste into the new field. `callbackPort: 51789` is pinned to
  match that redirect URI; changing it breaks whichever whitelist an
  operator has already configured against it.

### Upgrade note

- **Shell-export users get a one-time reprompt.** Anyone who configured
  the plugin through `BIFROST_URL` / `BIFROST_VK` shell exports will be
  prompted once for `gateway_url` and `virtual_key` on upgrade, because
  `.mcp.json` no longer reads those two variables. The variables continue
  to work for the hook layer.

### Known limits

- **Hooks and subagents do not run in Desktop Chat or on claude.ai web
  chat.** ("Hooks and sub-agents run only in Cowork, so they appear
  grayed out in chat", support.claude.com/en/articles/13837440-use-plugins-in-claude.)
  Memory auto-injection, skill-discovery hints, and usage tracking are all
  hook-driven, so on those two surfaces the plugin reduces to its skills,
  its slash commands, and the gateway's MCP tools. The Cowork tab and the
  Code tab run the full plugin.
- **OAuth sign-in is not yet self-service.** A virtual key is the only
  Desktop install path that connects unattended today. Signing in with a
  company account instead still needs one of the two identity-provider
  changes above before a real login can complete.

## [1.4.2] — 2026-08-01

### Fixed
- Fixed curation automation counts to strictly enforce arithmetic.
- Expanded `${VAR}` on both sides before comparing endpoints.
- Added memory classification rules and repo-state guard checks.
- Documented ScreenPipe auto-ingest governance decision (Add a filter).

## [1.4.1] — 2026-07-29

### Fixed

- **Detect and report the MCP server-name collision between the two install methods.**
  Both documented paths register a server named `bifrost`: the plugin's bundled
  `.mcp.json` (using `${BIFROST_URL}`) and `claude mcp add`. Claude Code keys servers
  by name within a scope, so with both present the project entry cannot expand its
  placeholder and `mcp__bifrost__*` tools disappear in any directory carrying that
  `.mcp.json` — while `claude mcp list` still shows a connected `bifrost`. It reads as
  a gateway outage when the gateway is fine.

  The asymmetry made it worse: the hooks are unaffected, because they read the
  credential from `~/.claude.json` directly, so skills, memory and the tool roster keep
  working while the MCP tools are gone.

  SessionStart now names the collision and both fixes. `INSTALL.md` states the methods
  are mutually exclusive, and `bifrost-debug` gains a section for the symptom.

## [1.4.0] — 2026-07-29

### Changed — open-source readiness

- The endpoint-migration notice is configurable instead of compiled in. It still ships
  with this deployment's retired hostnames and `https://bifrost.culture4.life/mcp` as
  defaults, so the plugin installs and works as-is; `BIFROST_LEGACY_HOSTS`
  (comma-separated) and `BIFROST_CANONICAL_URL` let another operator retarget it
  without patching source, and an empty `BIFROST_LEGACY_HOSTS` disables it. Exact
  hostname matching is unchanged, so a lookalike domain still cannot trigger it.
- The documented gateway URL is `https://bifrost.culture4.life/mcp` throughout.
- Code comments and test fixtures use neutral server names rather than deployment
  ones, so the examples read correctly for anyone.
- Added `SECURITY.md` (reporting, and what the plugin touches: credentials, context
  injection, local and project state, signed policy) and `CONTRIBUTING.md`.
- No longer publishes an orphaned Ed25519 private key fixture. It was never tracked by
  git — `*.pem` is gitignored — but it sat in the working tree and would be included by
  `npm pack` from that tree. Nothing referenced it and its public half was trusted by
  nothing, so there is no exposure to remediate; a guard now fails the build on key
  material anywhere in the published file set.

### Fixed

- **Hooks can now authenticate.** Hook processes do not inherit Claude Code's MCP
  credential: `claude mcp add` (what `bin/install.js` and `auto-setup.cjs` use)
  writes the gateway URL and virtual key into `~/.claude.json`, never into the
  environment, and every lookup here was env-only. On an affected machine
  `gw.env()` returned empty, the background refresh never ran, and skill, memory
  and tool context were silently absent from every session while the static
  guidance still printed — so a plugin that had never worked looked healthy. The
  hooks now fall back to reading the MCP server entry from `~/.claude.json`.
  **This is a new file dependency**: the plugin reads `~/.claude.json` when the
  environment does not carry the credential.
- URL and key are always taken from the same source. Resolving them independently
  let a stale `export BIFROST_URL=…` pair with the key from `~/.claude.json` and
  send that key to a host it was never issued for.
- The gateway URL printed into session context is reduced to scheme, host and path.
  An MCP endpoint may legitimately carry credentials in userinfo or the query
  string, and everything emitted reaches the model.
- Flat tool names are split on the matched tool token rather than a guessed hyphen,
  so servers named like `luca-memory` and tools named like `skill-search` both
  resolve. The discovered tool is now called by the name the gateway advertised.
- The default memory relevance floor is 0 (was 0.45). Scores are not comparable
  across memory servers, and the previous default sat entirely above one gateway's
  measured range, silently dropping every scored fact.
- A degraded refresh no longer blanks a good cache, and no longer resurrects a
  capability the current run did not produce (memory revoked, KB wing disabled).
  Carried-over facts are marked stale, bounded to 7 days, and keep the previous
  timestamp so the staleness notice can still fire.
- The per-project cache key includes a hash of the full project path. Keying on the
  bare directory name made `~/a/backend` and `~/b/backend` share one cache and
  cross-inject each other's recalled facts.
- `guidance/bifrost-context.md` no longer claims top-level `for`/`if` must be
  wrapped in a `def` for `executeToolCode`. Verified false against a live gateway.

### Added

- **Usage counter and adaptive injection (`hooks/usage.cjs`, `PostToolUse` +
  `PostToolUseFailure`, async).** Every instruction this plugin injects was previously
  asserted and never measured: nothing could say whether `skill_search` was ever
  called, whether anything was recorded, or whether behaviour differed from before the
  plugin existed. A correct fix silently disabled the tool roster and no mechanism
  would have surfaced it. The counter records, per session, which capability classes
  were used and whether the call succeeded.

  **Counts only. No queries, arguments, results, prompts, paths or content of any
  kind, and nothing leaves the machine** — SessionStart reads the same local file.
  The stored shape is pinned by an exact key allowlist so a field cannot be added
  casually. Only tools matching the gateway's MCP namespace are counted; a local tool
  sharing a name is not attributed to the gateway.

  SessionStart then adapts. An agent that has searched the library in most recent
  sessions gets the calls and nothing else — the argument has been won, and the tokens
  are better not spent. One that has not searched in N sessions is told so, with the
  number. Below three observations nothing adapts. Measured: ~5,600 bytes when the
  habit is absent, ~4,200 when it is established.

- **Tool roster.** Discovery already walked the full code-mode catalog and threw it
  away, and only walked it at all when a capability was missing — so on a gateway
  where skills and memory are both flat it was never fetched. SessionStart now
  lists the code-mode servers with sample tool names, the four-step
  `listToolFiles` → `readToolFile` → `getToolDocs` → `executeToolCode` workflow,
  and the correct `fileName` parameter.
- **`bifrost-code-mode` skill** — full reference for reaching servers that are not
  exposed as flat tools.
- **Skill-library ordering.** SessionStart and UserPromptSubmit both name
  `skill_search` and `skill_navigate` and say to check the team library before
  improvising — then to judge what comes back on its merits (see *Changed*).
- **`Stop` hook (`hooks/session-reflect.cjs`), async.** Periodic memory check-in
  asking whether anything is worth remembering, first at turn 3 then every 8 turns,
  with later check-ins tapered to one line. Findings are appended to a local,
  git-ignored candidate file for review (see *Changed*), never written to shared
  memory by the hook. Answering "nothing" is explicitly permitted, and the check is
  not narrated to the user. Exit code is 0 on every path (exit 2 on `Stop` blocks a
  turn from ending), and session markers are pruned after 2 days.
- A one-line notice when the plugin is unconfigured or its cache is stale, instead
  of failing invisibly. It names which half expired, since the skill/memory cache and
  the tool-roster cache expire independently.
- **`/bifrost-candidates`** — reviews the recorded candidates and promotes approved
  ones into shared memory. Promotion requires explicit confirmation; a write path
  whose output nothing reads is not a loop.

### Changed

- Memory candidates are written to `.bifrost/candidates.md` in the project (created
  git-ignored by the hook), not to the shared corpus. `memory_search` accepts no tag
  or state filter, so a `candidate`-tagged entry would be recalled by every colleague
  immediately as settled knowledge — the tag would have labelled nothing and gated
  nothing. A local file is the only place a candidate is verifiably not recalled.
  Keeping it in the project rather than `~/.cache` also avoids a permission prompt on
  every append, and keeps the only copy of unreviewed findings out of a directory that
  cache cleaners purge.
- Later memory check-ins taper to one line, as the per-prompt nudge already does. The
  full criteria list is ~500 tokens and was byte-identical every 8 turns.
- The per-prompt skill nudge emits its full form once per session, then one line.
- The skill-library instruction no longer claims the contents are "validated" or
  demands precedence over the agent's own approach. Nobody validated a thousand
  skills and the navigator's labels are auto-generated; instructing the model to defer
  to a bad match is worse than not mentioning the library. It now says: check here
  first, then judge what comes back on its merits.
- The tool roster expires on the same schedule as the skill and memory context (24h),
  rather than never. It had been read through a path that skipped every check, so an
  unreachable gateway kept injecting a roster of arbitrary age while the notice
  claimed context had been skipped. Callers now pass an explicit emit tolerance:
  that is a different question from the 1h network-refresh interval, and conflating
  the two would drop the roster from any session starting more than an hour after the
  last refresh.
- The `Stop` hook creates `<project>/.bifrost/` for the candidate spool — the one
  place this plugin writes outside `~/.cache/bifrost-plugin/`. In-workspace avoids a
  permission prompt on every append; the directory is created self-ignoring. If it
  cannot be created, the check-in stays silent rather than naming an unusable path.
- Hooks drain stdout before exiting. Writes to a pipe are asynchronous on Windows and
  `process.exit()` does not flush them; SessionStart emits ~9KB.

## [1.3.2] — 2026-07-27

### Changed

- SessionStart now migrates clients from either retired public zrok hostname
  (`bifrostphil108.share.zrok.io` or `bifrostmcp108.share.zrok.io`) to
  `https://bifrost.culture4.life/mcp`. Both checks require an exact hostname;
  canonical and lookalike hosts remain silent.

## [1.3.1] — 2026-07-27

### Changed

- SessionStart now emits one migration line when `BIFROST_URL` uses
  `bifrostphil108.share.zrok.io`, directing that client to
  `https://bifrost.culture4.life/mcp`. It does not rewrite user configuration
  and stays silent for the canonical domain, lookalike hosts, and the separate
  `bifrostmcp108` machine/OAuth endpoint.

## [1.3.0] — 2026-07-24

Combined release folding two lines of work: the signed plugin-config client
(Ed25519) and removal of every hook side effect that organization marketplace
review flags, plus Claude Desktop OAuth connect guidance. Auth for existing
clients is unchanged (`x-bf-vk` header, `BIFROST_URL`/`BIFROST_VK` env).

### Added

- **Claude Desktop OAuth connect support (docs).** Desktop connects to the
  gateway's OAuth 2.1 MCP endpoint (RFC 9728 protected-resource metadata +
  Keycloak/idms bearer validation, served gateway-side) with a company SSO
  login — no key needed. The plugin ships the connect guidance (README
  *Authentication modes*, `bifrost-mcp-setup` Claude Desktop section,
  `bifrost-debug` step 7) and a local `mcp-remote` + VK fallback. The
  `x-bf-vk` header path used by the Claude Code CLI is untouched; Desktop and
  CLI clients coexist on one gateway. (The OAuth resource server lives in the
  gateway deployment, not this plugin.)
- **Signed plugin-config delivery (client half).** keyapp has been serving a
  signed, content-addressed plugin-config since v2, but the plugin never
  fetched it — admin policy and per-user opt-ins affected nothing. New
  `hooks/lib/plugin-config.cjs` (Node core only, no deps) closes the loop:
  fetches `/plugin-config/manifest.json` with the `x-bf-vk` header, verifies
  the Ed25519 signature over the canonical manifest payload, hash-checks the
  content-addressed bundle against the signed `sha256`, and caches it by
  `configVersion` + `sha256`.
- **Tri-state skill/tool policy is now applied.** `off` skills and tools are
  surfaced to the model as off-limits, `always_on` as mandatory; `available`
  is the default and emits nothing. The bundle is already the effective
  per-user config (keyapp deep-merges admin policy with the user's non-locked
  overrides server-side), so the plugin does not re-merge it.
- **Admin field locks.** The `BIFROST_SKILLS_INJECT` / `BIFROST_MEMORY_INJECT` /
  `BIFROST_KB_INJECT` toggles now resolve through the signed config: a field an
  administrator has locked wins over the local environment variable; an unlocked
  field still yields to it.
- `BIFROST_PLUGIN_CONFIG=0` kill switch disables the entire signed-config path.
  `BIFROST_PLUGIN_CONFIG_TTL_MS` (default 15min) caps how often the manifest is
  re-checked.

### Security

- **Fails closed.** An absent, tampered, or mismatched signature — or a bundle
  whose sha256 does not match the signed manifest — means nothing from the
  server is applied on that pass. The plugin falls back to the last
  cached-and-previously-verified config, or to no config at all. A bundle is
  only ever written to cache *after* both checks pass, so the cache is
  verified by construction.
- **Signing key pinned on first use (TOFU).** A key rotation is only honoured
  when `signingKeyId` changes. A gateway that silently swaps its key under the
  same `signingKeyId` is refused loudly rather than trusted.
- **`minBootstrapVersion` / `schemaVersion` gates.** If the gateway requires a
  newer plugin than this one, the config is refused cleanly with an upgrade
  message — never half-applied.
- **Desktop OAuth is validated gateway-side.** The gateway's OAuth MCP endpoint
  enforces issuer + audience (RFC 8707) + signature + expiry on the bearer token
  and maps the authenticated identity to a per-user virtual key
  (deny-by-default for unmapped users). This plugin holds no token-handling code.
- **No hook sends the key over cleartext HTTP** to non-loopback hosts
  (`hooks/lib/gateway.cjs`); `BIFROST_ALLOW_HTTP=1` restores the legacy
  private-network behavior deliberately.

### Changed

- Session start loads the config from cache only (zero network, sub-ms) and
  refreshes it in the existing detached `refresh.cjs` worker, so a slow or dead
  gateway can never delay or break session start.
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
