# Distribution guide — rolling bifrost-plugin out to a team

This guide separates repository state, organization mirrors, installed clients,
and running sessions. Assessment date: **2026-11-11**. Local validation is not
fleet readiness or proof of Chat/Cowork connectivity.

## Plugin behavior and rollout limits

- Claude Code is the primary supported installation path. Its plugin configuration
  supplies `${user_config.gateway_url}` and `${user_config.virtual_key}`. The
  marketplace entry enables the plugin by default; enabling does not prove auth.
- Six hook events run five scripts: SessionStart, UserPromptSubmit, Stop,
  PreToolUse, PostToolUse and PostToolUseFailure. See the [hook inventory](README.md#the-hooks-concretely).
- SessionStart reads local identity/project-scoped caches and starts a detached
  refresh. Background recall is opt-in; its query can include repository, branch,
  ticket and directory context, not just a fixed phrase. PromptSubmit can send a
  bounded prompt snippet to skill/memory search. `BIFROST_REFRESH=0` disables the
  detached refresh, not all gateway use.
- Hooks maintain local state; reflection can create a project candidate file.
  Explicit onboarding and optional auto-login/migration have additional effects.
  `auto_login` and `migrate_legacy` default off. Assess those options separately.
- Do not infer Chat/Cowork MCP support from a valid manifest: Chat ignores this
  user-config URL; Cowork skips the entry because the referenced virtual key lacks
  a default. Keep per-user secrets out of defaults and use a separately verified
  connector for those surfaces. [Platform support](https://claude.com/docs/plugins/platform-support).

## Importing as a claude.ai organization marketplace

If an org admin adds this plugin under **claude.ai admin settings → plugins**
(rather than each engineer running `/plugin marketplace add`), two extra
platform rules apply:

Organization distribution has its own source, screening and administration rules.
Check the current [organization sync requirements](https://claude.com/docs/plugins/org-sync)
for the selected host before importing a mirror. Historical screening of another
version is not approval of this revision or of opt-in login/migration features.
Run manifest validation and test the intended surface separately.

The shipped endpoint is a **user-config template**, not `${BIFROST_URL}`. For a
managed connector that needs a fixed URL, an operator may prepare a separate
configuration using that endpoint and per-user authentication. A private mirror's
URL alone does not establish header support or user identity in Chat/Cowork.
Never embed a shared virtual key. Validate connector auth on the target surface.

### Auto-login for org-pushed installs (1.9.0)

An org-required plugin arrives with an empty `virtual_key`. In the private
mirror, set `"default": true` on `auto_login` in `.claude-plugin/plugin.json`
and, if the keyapp is not on the gateway's host, a `keyapp_url` default. Each
user's first interactive session then opens company sign-in once, caches the
key locally and feeds it to the MCP connection through the `headersHelper`.
Headless runs (`claude -p`, SDK, `CI`) and Cowork or remote sessions never
open a browser. A failed attempt waits 6 hours before retrying, 30 minutes
after a sign-in that timed out.

### Migrating existing users (`migrate_legacy`, 1.9.0)

Two older setups keep the org-synced plugin from working, and both are common on
machines onboarded before the plugin existed:

1. **A hand-added `bifrost` MCP server** (`claude mcp add`, the key page,
   `scripts/install.js`) at the same URL. Claude Code drops a plugin server that
   duplicates a manually configured URL, so the plugin's server and its
   `headersHelper` never run.
2. **A self-installed `bifrost-plugin@bifrost-marketplace`.** A synced plugin
   loses every name conflict, so the org copy never loads while the marketplace
   copy is installed.

**Case 1: `migrate_legacy`.** Set `"default": true` on `migrate_legacy` in the
private mirror. Once a day, a detached worker (`hooks/migrate-legacy.cjs`) moves
the key of a matching `bifrost` entry into the plugin's key cache and runs
`claude mcp remove bifrost` (user scope, and local scope where that is
unambiguous). Only an entry named `bifrost` whose URL equals the gateway is
touched, and only when a key for the gateway exists afterwards. Claude Desktop's
own `claude_desktop_config.json` is not read by Claude Code at startup and does
not collide.

**Case 2: managed settings.** Disable the marketplace copy fleet-wide through
managed settings (MDM profile or `managed-settings.json`):

```json
{ "enabledPlugins": { "bifrost-plugin@bifrost-marketplace": false } }
```

Per the plugin loading docs only an *enabled* plugin of another origin wins the
name conflict, so with the marketplace copy disabled the synced copy loads. This
needs no cooperation from the old copy, which matters because the old copy is
the public build. Users can uninstall the disabled copy at leisure with
`claude plugin uninstall bifrost-plugin@bifrost-marketplace`.

## Per-user onboarding (what each engineer does)

1. In Claude Code, `/plugin marketplace add neXenio/bifrost-plugin` then `/plugin install bifrost-plugin`.
2. Supply gateway URL and personal key in plugin configuration; no shell exports are required.
3. Enable the plugin, then `/reload-plugins` where supported or start a new session.
4. Verify: `/mcp` lists `bifrost`; type "set up bifrost" / `/bifrost-debug` if not.

> The manual CLI-registration fallback uses environment variables when configured
> with runtime placeholders. Those variables must exist in the launching process;
> a GUI launch does not necessarily inherit shell-profile exports.

## Gateway prerequisites — REQUIRED before a 300-user rollout

These are **not** solved by the plugin and must be in place first:

1. **Production gateway, not a dev tunnel.** A single laptop behind an ad-hoc
   tunnel will not serve 300 users. Deploy bifrost on real infra (container/VM),
   with a stable DNS name, TLS, health checks, and restart-on-failure.
2. **Virtual-key provisioning at scale.** 300 personal `vk_…` keys need to be
   minted and distributed securely (secrets manager / MDM — never a shared key,
   never in the repo). Plan revocation/rotation.
3. **Memory/skill server capacity.** Measure `memory_search` and skill-search latency
   under the intended concurrent load. Historical single-deployment timings are
   not a capacity estimate for the current service. Note: the plugin's cached session-start hook is
   unaffected (it never waits), but **mid-session** `memory_search` / `skill_search`
   latency is bounded by gateway capacity.
4. **Rate limits / budgets per VK** so one user can't exhaust shared resources.
5. **Observability**: per-VK request metrics, error rates, gateway saturation.

## Suggested rollout

- **Pilot (5–10 engineers)** against the production gateway. Watch gateway
  saturation and `memory_search`/`skill_search` latency under real concurrency.
- **Waves** of ~30–50, monitoring gateway load between waves.
- **Full fleet** once latency holds under load.
- **Rollback**: push `/plugin disable bifrost-plugin` guidance or unpublish the
  marketplace entry. Since the plugin ships `defaultEnabled: true`, new installs
  are active, so unpublishing stops new installs but does not disable existing
  ones — plan a disable broadcast, not just an unpublish. Review opt-in migration separately: it can remove a matching manual MCP entry.

## Go / no-go

- Plugin: validate the exact candidate revision and installed client version; no
  blanket readiness claim follows from historical v1.5.0 testing.
- Distribution to 300: **gated on gateway prerequisites 1–5 above.** Ship to the
  pilot first; do not fan out to 300 until the memory/skill server is proven under
  concurrent load.

## Updating outgoing-copy guidance (1.10.2)

The outgoing company communications requirement ships in the plugin's SessionStart guidance and the base AGENTS skill stanza. Publish or synchronize version 1.10.2 through the same marketplace or private organization mirror that clients already use; updating the public repository alone does not update a private mirror or prove that installed clients have refreshed.

After the client updates its installed plugin, start a new session on a hook-enabled surface and verify that the context contains “Outgoing company communications — final quality pass”. Already-running sessions retain their existing context. Desktop Chat and claude.ai web do not run SessionStart hooks; use their managed instructions or the supplied AGENTS stanza where supported instead of claiming hook coverage there. Existing manually copied AGENTS stanzas also need their managed block refreshed; changing this template does not rewrite those files remotely.

The gateway's advertised skill catalog must expose `anti-ai-slop-docs-marketing`. Missing availability is reported by the workflow; plugin version alone does not prove the skill can be retrieved. No new gateway URL, credentials, service deployment or automatic send/publish action is introduced.
