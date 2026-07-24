# bifrost-plugin

Claude Code plugin for any [Bifrost](https://github.com/maximhq/bifrost) MCP
gateway: one-command setup, skill discovery, and agent-driven memory via MCP.

**Scope: Claude Code only.** Other editors (Cursor, Codex, Antigravity, Augment) are deferred to v2.

The skill-discovery and memory features need a gateway that exposes a skill server
and/or a memory server. Without them, the plugin still wires up the gateway and
degrades gracefully — those features simply no-op.

---

## What it does

| Pillar | Behavior |
|--------|----------|
| 1 — Skill discovery | Non-trivial prompts get a hint to call the gateway's skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) before starting |
| 2 — One-command onboarding | `node bin/install.js --key vk_…` (or `/bifrost-setup`) wires the MCP entry in seconds |
| 3 — Agent-driven memory | The agent recalls relevant context via the gateway's memory MCP tools before non-trivial tasks, and saves decisions after significant work — no automatic injection |

See [guidance/bifrost-guide.md](./guidance/bifrost-guide.md) for the full engineer guide.

---

## Configuration

The plugin is driven by env vars (set once — see [Persisting env vars](#persisting-env-vars)):

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Gateway `/mcp` endpoint (include the `/mcp` path) | placeholder in `.mcp.json` |
| `BIFROST_VK` | Virtual key for the `x-bf-vk` auth header (`vk_…` or `sk-bf-…`) | (unset — required) |
| `BIFROST_SKILLS_SERVER` | Skill MCP server name — fallback for hook hints when auto-discovery cache is cold | `skills` |

Hooks **auto-discover** the real skill-server name from your gateway's tool list
(e.g. `skills-skill_search` → server `skills`). Check `/mcp` for the
prefix on `*-skill_search` / `*-get_skill` and set `BIFROST_SKILLS_SERVER` to
match if your gateway does not use the default `skills`.

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_KB_WING` | Knowledgebase wing/scope passed as `wing=` to the memory server's `memory_search` | (unset — KB recall skipped) |
| `BIFROST_KB_QUERY` | Query string used for the KB recall (falls back to the per-project memory query) | project-derived query |
| `BIFROST_KB_INJECT` | Set to `0` to disable the KB recall header at session start | (enabled) |
| `BIFROST_MEMORY_INJECT` | Set to `0` to disable the memory recall header at session start | (enabled) |
| `BIFROST_SKILLS_INJECT` | Set to `0` to disable the skill-library primer at session start | (enabled) |
| `BIFROST_REFRESH` | Set to `0` to disable the background cache refresh entirely (no session-start-initiated network traffic) | (enabled) |
| `BIFROST_REFRESH_INTERVAL_MS` | Minimum interval between background gateway refreshes | `3600000` (1 hour) |
| `BIFROST_ALLOW_HTTP` | Set to `1` to let hooks contact a plain-HTTP gateway on a non-loopback host (legacy private-network deployments — the key crosses the wire unencrypted) | (off — HTTPS or loopback only) |
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

Injected memory/KB sizing is adaptive, not a flat fact count — `hooks/refresh.cjs`
fetches a wider candidate pool from `memory_search`, then keeps the most similar
results within a character budget (higher-similarity facts get a larger snippet):

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_MEMORY_MAX_FACTS` | Cap on facts injected per section (memory, KB) | `6` |
| `BIFROST_MEMORY_SNIPPET_LEN` | Base per-fact snippet length in characters | `180` |
| `BIFROST_INJECT_BUDGET` | Total character budget per section (~4 chars/token) | `2000` (~500 tokens) |
| `BIFROST_MEMORY_MIN_SIM` | Drop `memory_search` results below this similarity score | `0.45` |
| `BIFROST_MEMORY_FAST` | Set to `1` to pass `fast:true` to `memory_search` (server-side fast path) | `0` (off — opt-in until the gateway ships the param) |

If `memory_search` returns similarity/score metadata, results are ranked and
budget-filled; if not (or the response isn't parseable JSON), it falls back to
the original flat-cap behavior so recall never breaks on an older gateway.

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
2. Persist gateway URL, key, and skill-server name (see [Persisting env vars](#persisting-env-vars)).
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
`$BIFROST_URL` / `$BIFROST_VK` when you enable it — no installer script needed.
It ships **disabled** (`defaultEnabled: false`) so it stays dormant until you set
your key. Type **"set up bifrost"** or `/bifrost-onboard` for a guided walkthrough,
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
node bin/install.js --key vk_<your-key>   # then persist env vars as above
node bin/install.js --dry-run             # prints the claude mcp add command instead
```

> **macOS:** Prefer `~/.claude/settings.json` (see above) over shell profile alone.
> Dock/Spotlight launches do not inherit `~/.zshrc`.

---

## Requirements

- Node.js >= 18
- Claude Code with MCP support
- `BIFROST_URL` set to your gateway's `/mcp` endpoint
- `BIFROST_VK` set to your virtual key (from your gateway operator)

---

## Skills

| Skill | Trigger |
|-------|---------|
| `bifrost-onboard` | "set up bifrost", "onboard me to bifrost", "install bifrost gateway" |
| `bifrost-debug` | "bifrost not working", "mcp not connecting", "skills not found" |
| `bifrost-mcp-setup` | "manually add bifrost mcp", "edit mcp.json for bifrost", "installer failed" |

---

## How the MCP server gets registered

Marketplace installs need no registration step at all: the plugin ships this
`.mcp.json`, which Claude Code auto-discovers when the plugin is enabled:

```json
{
  "mcpServers": {
    "bifrost": {
      "type": "http",
      "url": "${BIFROST_URL}",
      "headers": { "x-bf-vk": "${BIFROST_VK}" }
    }
  }
}
```

The manual fallback (`bin/install.js`, or `/bifrost-setup`) registers the same
server at user scope via `claude mcp add --scope user` — the plugin never edits
Claude Code config files itself. `${BIFROST_URL}` and `${BIFROST_VK}` are
resolved at runtime from Claude Code's environment (`~/.claude/settings.json`
`env` key and/or your shell). Without `--key`, the key is never stored in any
file.

---

## Verify

After install, enable, and restart:

1. `/mcp` — `bifrost` should be connected; note tool prefixes (e.g. `skills-skill_search`).
2. `/doctor` — no hook-load errors for `bifrost-plugin`.
3. Call `mcp__bifrost__<skills-server>-skill_search` with a task description — should return matches.
4. Type **"bifrost debug"** or `/bifrost-debug` for the full decision tree.

---

## Troubleshooting

**401 / 403 from bifrost** — `BIFROST_VK` missing or wrong. Check `~/.claude/settings.json` `env` and restart CC.

**Skill-search tool not found** — bifrost MCP not loaded, or gateway exposes no skill server. Run `/mcp`; confirm tool names match `BIFROST_SKILLS_SERVER`.

**Repository skill missing from `skill_search` / `get_skill`** — skill may be in the Bifrost marketplace but not yet in the MCP index (see [Gateway skill discovery vs Bifrost Skills Repository](#gateway-skill-discovery-vs-bifrost-skills-repository)).

**`/doctor` duplicate hooks** — fixed in v1.0.1; update the marketplace and reinstall.

**Hooks not firing** — hooks ship inside the plugin (`hooks/hooks.json`, auto-loaded by Claude Code). Confirm installed + enabled via `/plugin`, then restart.

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

.mcp.json (shipped)  →  bifrost MCP server  →  mcp__bifrost__<server>-<tool> (skills, memory, …)

Memory: agent calls mcp__bifrost__<memory-server>-search before tasks,
        mcp__bifrost__<memory-server>-store after significant work.
```

All hooks silent-fail: any error exits 0 silently so they never block a prompt.
Hooks write only to their own cache under `~/.cache/bifrost-plugin/` — they
never touch Claude Code configuration, launch other programs, or open browsers.
The background cache refresh contacts the gateway at most once per hour
(`BIFROST_REFRESH=0` disables it), sending only the project directory basename
plus a fixed recall phrase.

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
