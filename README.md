# bifrost-plugin

Claude Code plugin for any [Bifrost](https://github.com/maximhq/bifrost) MCP
gateway: plugin registration with lifecycle hooks, skill discovery, agent-driven memory, and MCP.

**Primary Target: Claude Code Plugin Registration** (includes hooks, skills, and memory).
*Standalone Remote MCP support is also available for Claude Desktop & web custom connectors.*

The skill-discovery and memory features need a gateway that exposes a skill server
and/or a memory server. Without them, the plugin still wires up the gateway and
degrades gracefully — those features simply no-op.

---

## What it does

| Pillar | Behavior |
|--------|----------|
| 1 — Plugin Lifecycle Hooks | Auto-injects recalled memory context at session start, enforces skill-discovery hints before non-trivial tasks, spools memory candidates, and tracks capability usage |
| 2 — Skill discovery | Non-trivial prompts get a hint to call the gateway's skill-search tool (`<prefix><skills-server>-skill_search`, see Tool names below) before starting |
| 3 — One-command onboarding | `/plugin install bifrost-plugin` or `node scripts/install.js --key vk_…` (or `/bifrost-setup`) |
| 4 — Agent-driven memory | Recalls context via gateway memory tools before non-trivial tasks and saves durable decisions after work |

### The hooks, concretely

Five hook events are registered in [`hooks/hooks.json`](./hooks/hooks.json), run by
four scripts — `PostToolUse` and `PostToolUseFailure` share one. All of them fail
silently and always exit 0, so a broken gateway can never block a session.

| Event | Script | What it does |
|-------|--------|--------------|
| `SessionStart` | `session-start.cjs` | Emits the gateway primer, skill library, MCP tool roster and recalled memory, all from a local cache (no blocking network). Spawns the detached refresh worker afterwards. |
| `UserPromptSubmit` | `prompt-submit.cjs` | On a prompt containing a task verb, adds one line pointing at the skill library. Full form once per session, then tapered. |
| `Stop` (async) | `session-reflect.cjs` | Every few turns, asks whether anything was learned worth appending to the project's `.bifrost/candidates.md`. Never writes memory itself. |
| `PostToolUse` / `PostToolUseFailure` (async) | `usage.cjs` | Counts, per session, which capability classes were used and whether calls succeeded. Counts only — never queries, arguments or results, and nothing leaves the machine. `SessionStart` reads it back to decide how hard to push. |

Cached context is emitted for up to 14 days and labelled with its age once past 24
hours, rather than withheld — the session that has been away longest is the one that
needs the primer most. A background refresh runs at most hourly.

See [guidance/bifrost-guide.md](./guidance/bifrost-guide.md) for the full engineer guide.

---

## Registration and connection modes

Claude Desktop is one app with three tabs (Code, Cowork, Chat), and each tab
hosts plugins differently. Counting the CLI and claude.ai on the web, that is
five surfaces the plugin can run on:

| Surface | Skills | Slash commands | MCP tools | Hooks | Subagents |
|---|---|---|---|---|---|
| Claude Code CLI | yes | yes | yes | yes | yes |
| Desktop, Code tab | yes | yes | yes | yes | yes |
| Desktop, Cowork tab | yes | yes | yes | yes | yes |
| Desktop, Chat tab | yes | yes | yes | **no** | **no** |
| claude.ai web chat | yes | yes | yes | **no** | **no** |

> "Hooks and sub-agents run only in Cowork, so they appear grayed out in chat."
> Source: [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)

On the Chat tab and on claude.ai web, this plugin's memory auto-injection,
skill-discovery hints, and usage tracking do not run, because all three are
hook-driven. What still works there: the four bundled skills, the five slash
commands, and the gateway's MCP tools.

### Install

- **Claude Code CLI:** `/plugin marketplace add neXenio/bifrost-plugin` → `/plugin install bifrost-plugin`
- **Desktop, Code tab:** `+` button next to the prompt box → Plugins → Add plugin
- **Desktop, Chat and Cowork tabs, and claude.ai web:** Customize (left sidebar) → Plugins tab → Browse plugins → Add from a repository, pointing at the GitHub repo. Plugins added this way sync through your claude.ai account, not from `~/.claude`.

Every path prompts for the plugin's config at install time: the gateway URL
(`gateway_url`, prefilled with `https://bifrost.culture4.life/mcp`) and a
virtual key (`virtual_key`).

Get the key yourself, no ticket needed. Open
[https://bifrost.culture4.life/](https://bifrost.culture4.life/), sign in
with your company account, and the page shows your key with a copy button.
The first visit creates it, later visits show the same one, and there is a
Rotate button if it ever leaks. Your sign-in address has to be on
`luca-app.de` or `nexenio.com`, otherwise the page answers `403 domain not
permitted` after an otherwise successful login.

That is the whole install for someone who does not use a terminal: get the
key, add the plugin, paste the key. The opt-in `auto_login` option removes the
paste step by fetching the key through company sign-in.

### Virtual key or sign-in

The virtual key (`vk_...`, self-served from
[https://bifrost.culture4.life/](https://bifrost.culture4.life/)) is the auth
path that works today, on every surface, with nothing set in your shell.
Paste it into the `virtual_key` field at install time and the MCP connection
is live.

With `auto_login` on and `virtual_key` blank, the first interactive session
opens the company sign-in page once and caches the key it gets back in
`~/.cache/bifrost-plugin/vk`. The plugin no longer ships an `oauth` block in
`.mcp.json` (removed in 1.9.0): Claude Code never substituted
`${user_config.oauth_client_id}` inside it, so Keycloak always received the
literal placeholder, and it offered a second, broken sign-in path next to the
working one. A wrong key returns a 401 with no `WWW-Authenticate` header;
clear the `virtual_key` field rather than leaving a bad one in it.

### Legacy fallback: Desktop local proxy

Prefer the plugin install path above. Use this only where you cannot install
the plugin at all (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS):

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "npx",
      "args": [
        "mcp-remote", "https://bifrost.culture4.life/mcp",
        "--transport", "http-only",
        "--header", "x-bf-vk:${BIFROST_VK}"
      ],
      "env": { "BIFROST_VK": "vk_<your-key>" }
    }
  }
}
```

No spaces around `:` in the `--header` arg (argument-parsing quirk on some
platforms). This file then contains your key, so treat it as a secret and
keep its permissions tight.

---

## Configuration

The gateway URL and key come from the install-time plugin config
(`gateway_url` / `virtual_key`), and the hooks read those same values, so a
normal install needs nothing here. The env vars below are overrides, plus the
knobs that have no plugin-config equivalent (see
[Persisting env vars](#persisting-env-vars)).

Credentials resolve in this order: the `BIFROST_URL` + `BIFROST_VK` pair, then
the plugin config, then a scan of `~/.claude.json`. Each source is
all-or-nothing, so a URL is never paired with a key from somewhere else.

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Overrides the gateway `/mcp` endpoint the hooks call. Only takes effect together with `BIFROST_VK` | (unset: plugin config is used) |
| `BIFROST_VK` | Overrides the virtual key the hooks send as `x-bf-vk`. Only takes effect together with `BIFROST_URL` | (unset: plugin config is used) |
| `BIFROST_SKILLS_SERVER` | Skill MCP server name — fallback for hook hints when auto-discovery cache is cold | `skills` |

Hooks **auto-discover** the real skill-server name from your gateway's tool list
(e.g. `skills-skill_search` → server `skills`). Check `/mcp` for the
prefix on `*-skill_search` / `*-get_skill` and set `BIFROST_SKILLS_SERVER` to
match if your gateway does not use the default `skills`.

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_KB_WING` | Knowledgebase wing/scope narrowing the memory server's `memory_search`, sent as `filters={"wing": …}` | (unset — KB recall skipped) |
| `BIFROST_KB_QUERY` | Query string used for the KB recall (falls back to the per-project memory query) | project-derived query |
| `BIFROST_KB_INJECT` | Set to `0` to disable the KB recall header at session start | (enabled) |
| `BIFROST_MEMORY_INJECT` | Set to `0` to disable the memory recall header at session start | (enabled) |
| `BIFROST_MEMORY_PRIME` | Set to `1` to also inject recalled facts (and KB facts) at session start. Off by default: the header then only carries the recall/store guidance and no `memory_search` runs at session start. Signed plugin-config field `memoryPrime`, lockable | (off) |
| `BIFROST_SKILLS_INJECT` | Set to `0` to disable the skill-library primer at session start | (enabled) |
| `BIFROST_REFRESH` | Set to `0` to disable the background cache refresh entirely (no session-start-initiated network traffic) | (enabled) |
| `BIFROST_REFRESH_INTERVAL_MS` | Minimum interval between background gateway refreshes | `3600000` (1 hour) |
| `BIFROST_ALLOW_HTTP` | Set to `1` to let hooks contact a plain-HTTP gateway on a non-loopback host (legacy private-network deployments — the key crosses the wire unencrypted) | (off — HTTPS or loopback only) |

### Pre-approving the gateway's tools

By default Claude Code asks for permission the first time it calls each gateway
tool. A gateway exposes a lot of them, so that is a lot of prompts. To approve
the whole server once, add this to `~/.claude/settings.json` (all your projects)
or to `.claude/settings.json` in one repo:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_bifrost-plugin_bifrost",
      "mcp__bifrost"
    ]
  }
}
```

A bare `mcp__<server>` rule covers every tool on that server; `mcp__<server>__<tool>`
narrows it to one. Both names are listed above because the server is called
`bifrost` when its `.mcp.json` is picked up as a project MCP server and
`plugin_bifrost-plugin_bifrost` when it arrives through the plugin — run `/mcp`
to see which one you have. Extra rules for a server you do not have are inert.

Two caveats worth knowing before you rely on this:

- **The plugin cannot ship this for you.** A plugin manifest may only carry
  `agent` and `subagentStatusLine` settings; a `permissions` block in
  `plugin.json` passes `claude plugin validate` and is then silently dropped at
  load time, so it looks applied and is not. Granting tool permission stays a
  decision on your side of the boundary, which is the right default — it just
  means this snippet is a manual step.
- **This is Claude Code only.** Claude Desktop and claude.ai gate tools through
  their own approval UI and do not read `settings.json`. On those surfaces,
  approve the server when prompted.

For a fleet, the same block goes in the managed settings file your MDM deploys,
which also stops individual users from removing it.

### Running your own gateway

The plugin works against any Bifrost gateway — point `BIFROST_URL` at it. The only
deployment-specific behaviour is the endpoint-migration notice, which tells users on a
retired hostname where to move. It ships configured for the neXenio gateway and is
retargetable:

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_LEGACY_HOSTS` | Comma-separated hostnames being retired. Matched exactly — a lookalike domain ending in one of these does not trigger it. | (unset — notice disabled) |
| `BIFROST_CANONICAL_URL` | Gateway URL the notice tells users to move to | `https://bifrost.culture4.life/mcp` |

The retired hostnames are **not** compiled in: they are per-machine tunnel endpoints,
and a plugin anyone can install should not ship a roster of one organisation's
infrastructure. Enabling the notice therefore takes one line of operator config — put
it where your team already sets env, e.g. `~/.claude/settings.json`:

```json
{ "env": { "BIFROST_LEGACY_HOSTS": "old-tunnel-a.example,old-tunnel-b.example" } }
```

Anyone still pointing at one of those hosts is then told, once per session, to move to
`BIFROST_CANONICAL_URL`. Without it the notice never fires and users on a retired
endpoint get no signal — which is the trade: nothing published, nothing automatic.
| `BIFROST_KEYAPP_URL` | SSO keyapp URL — powers the explicit `/bifrost-setup` browser provisioning flow and signed plugin-config delivery | (unset — both skipped) |
| `BIFROST_PLUGIN_CONFIG` | Set to `0` to disable signed plugin-config delivery entirely (kill switch) | (enabled when `BIFROST_KEYAPP_URL` + `BIFROST_VK` are set) |
| `BIFROST_PLUGIN_CONFIG_TTL_MS` | How long a fetched plugin-config stays fresh before the manifest is re-checked | `900000` (15 min) |

### Signed plugin-config

When `BIFROST_KEYAPP_URL` and `BIFROST_VK` are set, the plugin fetches an
Ed25519-signed, content-addressed config bundle from keyapp
(`hooks/lib/plugin-config.cjs`). The bundle carries the administrator's hook
config plus a tri-state (`always_on` / `available` / `off`) policy for skills and
MCP tools, already merged with your own non-locked opt-ins on the server.

- Session start reads it **from cache only** — zero network, so a slow or dead
  gateway never delays or breaks a session. A detached worker refreshes it.
- It **fails closed**: a bad signature, a bundle whose `sha256` does not match the
  signed manifest, or a gateway demanding a newer plugin means *nothing* from the
  server is applied — the last verified config (or none) stays in effect.
- The signing key is **pinned on first use**. Rotations are only honoured when
  `signingKeyId` changes; a silent key swap is refused and reported.
- Fields an administrator has **locked** override the corresponding environment
  variable above. Unlocked fields still yield to your local setting.

Fact priming is opt-in (`BIFROST_MEMORY_PRIME=1`); the sizing below only applies when it
is on. Injected memory/KB sizing is adaptive, not a flat fact count — `hooks/refresh.cjs`
fetches a wider candidate pool from `memory_search`, then keeps the most similar
results within a character budget (higher-similarity facts get a larger snippet):

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_MEMORY_MAX_FACTS` | Cap on facts injected per section (memory, KB) | `6` |
| `BIFROST_MEMORY_SNIPPET_LEN` | Base per-fact snippet length in characters | `180` |
| `BIFROST_INJECT_BUDGET` | Total character budget per section (~4 chars/token) | `2000` (~500 tokens) |
| `BIFROST_MEMORY_MIN_SIM` | Drop `memory_search` results below this score. Applies to luca-memory's `similarity` field (true cosine); needs a luca-memory that returns it, since older servers return only the RRF `relevance` and then nothing is injected. 0.55 comes from a replay of 770 real hook calls (judged precision about 0.82 at 0.55 vs 0.73 at 0.45) | `0.55` |
| `BIFROST_MEMORY_FAST` | Set to `1` to pass `fast:true` to `memory_search` (server-side fast path) | `0` (off — opt-in until the gateway ships the param) |

If `memory_search` returns similarity/score metadata, results are ranked and
budget-filled. Rows with no numeric score (an unrecognised response shape, plain
strings, the regex fallback) are dropped while any floor is active; they are kept
only when both `BIFROST_MEMORY_MIN_SIM=0` and `BIFROST_MEMORY_RELATIVE_FLOOR=0`.

There is **no separate KB MCP server** — KB recall is `memory_search` against
the memory server, scoped to the KB wing via `wing=<BIFROST_KB_WING>`. No wing
name is assumed by default, so KB recall stays off until you set
`BIFROST_KB_WING` to match your gateway's knowledgebase scope.

---

## Install

Get your gateway `/mcp` URL and personal virtual key (`vk_…`) from your gateway
operator, then:

### Recommended — marketplace install (3 steps)

1. In Claude Code:
   ```
   /plugin marketplace add neXenio/bifrost-plugin
   /plugin install bifrost-plugin@bifrost-marketplace
   ```
2. Answer the install prompt with your gateway URL and virtual key. Only set env vars if you need an override or a non-default skill-server name (see [Persisting env vars](#persisting-env-vars)).
3. Enable and restart Claude Code:
   ```
   /plugin enable bifrost-plugin
   ```

To pick up a new plugin release:
```
/plugin marketplace update bifrost-marketplace
/plugin install bifrost-plugin@bifrost-marketplace
```

### Persisting env vars

Claude Code does **not** read `~/.zshrc` when launched from the Dock or Spotlight.
Use **`~/.claude/settings.json`** so vars apply on every launch:

```json
{
  "env": {
    "BIFROST_URL": "https://<your-gateway-host>/mcp",
    "BIFROST_VK": "vk_<your-key>",
    "BIFROST_SKILLS_SERVER": "skills"
  }
}
```

Also add the same exports to `~/.zshrc` (or `~/.bashrc`) if you use the gateway
from a terminal. Restart Claude Code after editing settings.

Example shell profile lines:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
echo 'export BIFROST_SKILLS_SERVER=skills' >> ~/.zshrc   # if not "skills"
source ~/.zshrc
```

The plugin ships a `.mcp.json`, so the `bifrost` MCP server wires itself from
the gateway URL and virtual key you enter in the install-time plugin config
prompt, no installer script and no shell env vars needed. It ships
**enabled** (`defaultEnabled: true`), so installing it activates it right
away. Leave the virtual key blank at the install prompt and it stays inert —
no key means no gateway connection. `/plugin disable bifrost-plugin` turns it
off. Type **"set up bifrost"** or `/bifrost-onboard` for a guided walkthrough,
`/bifrost-debug` if something's off.

### Gateway skill discovery vs Bifrost Skills Repository

These are **two different** skill paths — do not confuse them:

| Path | How skills are accessed | Typical use |
|------|-------------------------|-------------|
| **MCP skill server** (`skills-skill_search`, `get_skill`) | Runtime search over the gateway's skill index | What **this plugin** nudges you to use before non-trivial work |
| **Bifrost Skills Repository marketplace** | `<gateway>/api/skills/serve/claude-code/.claude-plugin/marketplace.json` | Install individual skills as Claude Code plugins (`bifrost-<skill-name>`) |

A skill published in the Bifrost dashboard may appear in the repository marketplace
before it is ingested into the MCP skill index. If `get_skill` says a repository
skill does not exist but the admin UI shows it, the MCP index may be stale — use
the admin **Bump all-skills version** control or install the skill directly from
the repository marketplace. See [Bifrost Skills Repository docs](https://docs.getbifrost.ai/features/skills-repository).

### Fallback — manual installer

If you can't use the marketplace (air-gapped, etc.), clone and run the installer,
a thin wrapper that registers the server through Claude Code's own CLI
(`claude mcp add --scope user`) — it never edits config files directly:

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://<your-gateway-host>/mcp
node scripts/install.js --key vk_<your-key>   # then persist env vars as above
node scripts/install.js --dry-run             # prints the claude mcp add command instead
```

> **macOS:** Prefer `~/.claude/settings.json` (see above) over shell profile alone.
> Dock/Spotlight launches do not inherit `~/.zshrc`.

---

## Requirements

- Node.js >= 18
- Claude Code, or Claude Desktop, or claude.ai on the web
- Your gateway's `/mcp` endpoint and a virtual key from your gateway operator, entered at the install prompt
- If your gateway exposes a luca-memory server: **v0.42 or later**. v0.42 renamed and
  folded its tools with no compatibility aliases, and the plugin sends only that shape.
  Against an older server the memory features go silently empty — `/bifrost-debug`
  section 8 covers how to spot it. Skills and the rest of the gateway are unaffected.

---

## Skills

| Skill | Trigger |
|-------|---------|
| `bifrost-onboard` | "set up bifrost", "onboard me to bifrost", "install bifrost gateway" |
| `bifrost-debug` | "bifrost not working", "mcp not connecting", "skills not found" |
| `bifrost-mcp-setup` | "manually add bifrost mcp", "edit mcp.json for bifrost", "installer failed" |
| `bifrost-code-mode` | "executeToolCode", "code mode", "listToolFiles", "how do I call gitlab through the gateway" |
| `bifrost-gateway-essentials` | Always loaded — carries the core operating rules for surfaces where hooks don't run |

`bifrost-gateway-essentials` exists for a specific gap. The SessionStart hook
injects a gateway-specific context block naming your real servers, skill library
and memory corpus, but hooks run only in the Claude Code CLI and in Desktop's Code
and Cowork tabs. On Desktop's Chat tab and on claude.ai web, nothing is injected.
Skill descriptions are loaded on every surface whether or not the skill is
invoked, so that skill's description carries the parts that matter most —
above all that a missing `<prefix><server>-<tool>` usually means the
capability is in code mode behind `executeToolCode`, not that it is absent.

That is a partial substitute, not an equal one. A description can state the shape;
it cannot name your gateway's actual servers, because those are discovered at
runtime. The gateway's own MCP tool descriptions are served by the upstream MCP
servers and are not something this plugin can rewrite.

---

## Memory candidates

During a session the `Stop` hook periodically asks whether anything is worth
remembering. Findings are appended to **`.bifrost/candidates.md`** in the project
root, which the hook creates git-ignored on first use.

Candidates are **local and unreviewed**. Nothing is shared until someone promotes it:

```
/bifrost-candidates      # review, promote the good ones, prune the rest
```

They deliberately do not go straight into shared memory. The corpus has no read
permission model — `memory_search` takes filters, but they are the caller's own
retrieval narrowing, not an ACL the writer can set — so anything written to it is
recalled by every colleague immediately as settled team knowledge. A mid-session
judgement should not become company-wide fact without a human deciding it should.

What may be promoted, and what has to be redacted or withheld, is set out in
[guidance/memory-classification.md](./guidance/memory-classification.md); the
`/bifrost-candidates` triage step applies it.

Nothing is written automatically, and answering "nothing worth recording" is a normal
outcome. Delete the file at any time; it regenerates empty.

---

## How the MCP server gets registered

Marketplace installs need no registration step at all: the plugin ships this
`.mcp.json`, which Claude Code auto-discovers when the plugin is enabled:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "http",
      "url": "${user_config.gateway_url}",
      "headers": { "x-bf-vk": "${user_config.virtual_key}" }
    }
  }
}
```

`gateway_url` and `virtual_key` come from the plugin's `userConfig`, which
Claude Code prompts for at install time on every surface (see [Registration
and connection modes](#registration-and-connection-modes)).

The manual fallback (`scripts/install.js`, or `/bifrost-setup`) registers a
separate server at user scope via `claude mcp add --scope user`; the plugin
never edits Claude Code config files on its own. That path still resolves
`${BIFROST_URL}` and `${BIFROST_VK}` at runtime from Claude Code's
environment (`~/.claude/settings.json` `env` key and/or your shell), unlike
the plugin's own `.mcp.json` above. Without `--key`, the key is never stored
in any file.

---

## Verify

After install, enable, and restart:

1. `/mcp` — `bifrost` should be connected; note tool prefixes (e.g. `skills-skill_search`).
2. `/doctor` — no hook-load errors for `bifrost-plugin`.
3. Call `<prefix><skills-server>-skill_search` with a task description — should return matches.
4. Type **"bifrost debug"** or `/bifrost-debug` for the full decision tree.

---

## Troubleshooting

**401 / 403 from bifrost** — `BIFROST_VK` missing or wrong. Check `~/.claude/settings.json` `env` and restart CC.

**Skill-search tool not found** — bifrost MCP not loaded, or gateway exposes no skill server. Run `/mcp`; confirm tool names match `BIFROST_SKILLS_SERVER`.

**Repository skill missing from `skill_search` / `get_skill`** — skill may be in the Bifrost marketplace but not yet in the MCP index (see [Gateway skill discovery vs Bifrost Skills Repository](#gateway-skill-discovery-vs-bifrost-skills-repository)).

**`/doctor` duplicate hooks** — fixed in v1.0.1; update the marketplace and reinstall.

**Hooks not firing** — hooks ship inside the plugin (`hooks/hooks.json`, auto-loaded by Claude Code). Confirm installed + enabled via `/plugin`, then restart.

**Claude Desktop `mcp_registration_failed` / OAuth errors** — make sure you used the stable gateway URL (not an old ephemeral tunnel link), then run `/bifrost-debug` in Claude Code for the Desktop decision tree (PRM check, redirect-URI, audience/scope, VK mapping). The plugin itself no longer uses OAuth (since 1.9.0); use a virtual key or `auto_login`.

Type **"bifrost not working"** in Claude Code for the guided `bifrost-debug` diagnosis flow.

---

## Security

- `BIFROST_VK` is always `${BIFROST_VK}` in files — never a literal key value.
- `.gitignore` blocks `.env`, `*.key`, and `*_VK=*` patterns.
- The installer registers the server via `claude mcp add`; without `--key` it stores the `${BIFROST_VK}` template and the key never touches disk.
- Run `git grep -nE 'vk_[A-Za-z0-9]'` to confirm the repo is clean before any push.

---

## Architecture

```
SessionStart      →  session-start.cjs  →  prints guidance/bifrost-context.md (~400 tokens)
UserPromptSubmit  →  prompt-submit.cjs  →  skill-discovery hint for task-verb prompts

.mcp.json (shipped)  →  bifrost MCP server  →  <prefix><server>-<tool> (skills, memory, …)

Memory: agent calls <prefix><memory-server>-search before tasks,
        <prefix><memory-server>-store after significant work.
```

**Tool names.** `<prefix>` depends on how the gateway is connected: `mcp__plugin_bifrost-plugin_bifrost__` from the plugin, `mcp__claude_ai_luca_Bifrost__` from the claude.ai connector, `mcp__bifrost__` from a hand-added server (which hides the plugin's). The injected session context names the one that applies.

All hooks silent-fail: any error exits 0 silently so they never block a prompt.
By default hooks write only to their own cache under `~/.cache/bifrost-plugin/` and
never touch Claude Code configuration, launch other programs, or open browsers.
Two opt-in options, both off by default, change that. With `auto_login` on, a session
may open the browser once for company sign-in (`hooks/auto-setup.cjs`) and the key it
gets back is cached in `~/.cache/bifrost-plugin/vk`; the sign-in worker also rewrites
this plugin's entry in `~/.claude/mcp-needs-auth-cache.json`. With `migrate_legacy` on,
it runs `claude mcp remove` for a hand-added bifrost server.
The background cache refresh contacts the gateway at most once per hour
(`BIFROST_REFRESH=0` disables it). By default it sends no query at all: session-start
fact priming is off, so the worker only learns which skills and memory tools the
gateway offers. With priming on (`BIFROST_MEMORY_PRIME=1`) it sends one
`memory_search` whose query is the git remote's repository name (else the repo
directory name), a ticket key from the branch or directory name, and up to five
words from the branch name. Branch names can carry people's names, for example
`phil/LUCA-123-fix-login` becomes `my-repo LUCA-123 phil fix login`, and anything else
typed into a branch name is sent too. Credentials in a remote URL are dropped before
the name is taken. With `BIFROST_KB_WING` set, the KB recall sends the same query.

---

## Uninstall

```bash
# 1. Remove / disable the plugin from Claude Code:
#    /plugin   (then uninstall bifrost-plugin)   — or remove its dir under ~/.claude/plugins

# 2. If you registered the server manually (installer or /bifrost-setup):
claude mcp remove --scope user bifrost

# 3. Remove BIFROST_* from ~/.claude/settings.json env and ~/.zshrc / ~/.bashrc if you added them.

# 4. Optionally clear the plugin cache:
rm -rf ~/.cache/bifrost-plugin
```

---

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 neXenio GmbH.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
