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
(e.g. `lucaskills-skill_search` → server `lucaskills`). Check `/mcp` for the
prefix on `*-skill_search` / `*-get_skill` and set `BIFROST_SKILLS_SERVER` to
match if your gateway does not use the default `skills`.

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
    "BIFROST_SKILLS_SERVER": "lucaskills"
  }
}
```

Also add the same exports to `~/.zshrc` (or `~/.bashrc`) if you use the gateway
from a terminal. Restart Claude Code after editing settings.

Example shell profile lines:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
echo 'export BIFROST_SKILLS_SERVER=lucaskills' >> ~/.zshrc   # if not "skills"
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
| **MCP skill server** (`lucaskills-skill_search`, `get_skill`) | Runtime search over the gateway's skill index | What **this plugin** nudges you to use before non-trivial work |
| **Bifrost Skills Repository marketplace** | `<gateway>/api/skills/serve/claude-code/.claude-plugin/marketplace.json` | Install individual skills as Claude Code plugins (`bifrost-<skill-name>`) |

A skill published in the Bifrost dashboard may appear in the repository marketplace
before it is ingested into the MCP skill index. If `get_skill` says a repository
skill does not exist but the admin UI shows it, the MCP index may be stale — use
the admin **Bump all-skills version** control or install the skill directly from
the repository marketplace. See [Bifrost Skills Repository docs](https://docs.getbifrost.ai/features/skills-repository).

### Fallback — manual installer

If you can't use the marketplace (air-gapped, etc.), clone and run the installer,
which writes the entry into `~/.claude/mcp.json` directly:

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js --key vk_<your-key>   # then persist env vars as above
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

## What gets written to mcp.json

The plugin writes one entry to `~/.claude/mcp.json`:

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

`${BIFROST_URL}` and `${BIFROST_VK}` are resolved at runtime from Claude Code's
environment (`~/.claude/settings.json` `env` key and/or your shell). The key is
never stored in any file.

---

## Verify

After install, enable, and restart:

1. `/mcp` — `bifrost` should be connected; note tool prefixes (e.g. `lucaskills-skill_search`).
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
- The installer prints the `export` reminder to the terminal; it does not write the key anywhere.
- Run `git grep -nE 'vk_[A-Za-z0-9]'` to confirm the repo is clean before any push.

---

## Architecture

```
SessionStart      →  session-start.cjs  →  prints guidance/bifrost-context.md (~400 tokens)
UserPromptSubmit  →  prompt-submit.cjs  →  skill-discovery hint for task-verb prompts

~/.claude/mcp.json  →  bifrost MCP server  →  mcp__bifrost__<server>-<tool> (skills, memory, …)

Memory: agent calls mcp__bifrost__<memory-server>-search before tasks,
        mcp__bifrost__<memory-server>-store after significant work.
```

All hooks silent-fail: any error exits 0 silently so they never block a prompt.

---

## Uninstall

```bash
# 1. Remove / disable the plugin from Claude Code:
#    /plugin   (then uninstall bifrost-plugin)   — or remove its dir under ~/.claude/plugins

# 2. Remove the bifrost server entry from ~/.claude/mcp.json:
node -e "
const fs=require('fs'), os=require('os');
const f=os.homedir()+'/.claude/mcp.json';
try {
  const c=JSON.parse(fs.readFileSync(f,'utf8'));
  if (c.mcpServers) delete c.mcpServers.bifrost;
  fs.writeFileSync(f, JSON.stringify(c,null,2)+'\n');
  console.log('removed bifrost from', f);
} catch (e) { console.error('skip:', e.message); }
"

# 3. Remove BIFROST_* from ~/.claude/settings.json env and ~/.zshrc / ~/.bashrc if you added them.
```

---

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 neXenio GmbH.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
