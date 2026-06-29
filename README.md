# bifrost-plugin

Claude Code plugin for any [Bifrost](https://github.com/maximhq/bifrost) MCP
gateway: one-command setup, per-prompt context injection, skill discovery, and
session memory.

**Scope: Claude Code only.** Other editors (Cursor, Codex, Antigravity, Augment) are deferred to v2.

The memory and skill-discovery features need a gateway that exposes a memory
service and a skill server. Without them, the plugin still wires up the gateway
and degrades gracefully — those features simply no-op.

---

## What it does

| Pillar | Behavior |
|--------|----------|
| 1 — Memory injection | Every prompt is silently enriched with relevant context from the memory service (similarity >= 0.5, capped at 600 chars) |
| 2 — Skill discovery | Non-trivial prompts get a hint to call the gateway's skill-search tool (`mcp__bifrost__<skills-server>-skill_search`) before starting |
| 3 — One-command onboarding | `node bin/install.js --key vk_…` (or `/bifrost-setup`) wires the MCP entry in seconds |
| 4 — Session reflection | On session end, learnings are staged to `~/.cache/bifrost-plugin/staging/`; the next session start POSTs them to the memory service (`/memory/store`) and drains them to `processed/` |

See [guidance/bifrost-guide.md](./guidance/bifrost-guide.md) for the full engineer guide.

---

## Configuration

The plugin is driven by four env vars:

| Var | Purpose | Default |
|-----|---------|---------|
| `BIFROST_URL` | Gateway `/mcp` endpoint | `https://your-bifrost-gateway.example/mcp` (placeholder) |
| `BIFROST_VK` | Virtual key for the `x-bf-vk` auth header | (unset — required) |
| `BIFROST_MEMORY_URL` | Memory service base URL | `http://127.0.0.1:52421` |
| `BIFROST_SKILLS_SERVER` | Name of the gateway's skill server | `skills` |

---

## Install

Set `BIFROST_URL` to your gateway endpoint and get your `vk_<your-key>` from your
gateway operator.

### Recommended — run the installer

```bash
git clone https://github.com/neXenio/bifrost-plugin
cd bifrost-plugin
export BIFROST_URL=https://<your-gateway-host>/mcp
node bin/install.js --key vk_<your-key>
```

The installer merges the bifrost MCP entry into `~/.claude/mcp.json` (idempotent;
backs up to `mcp.json.bak`, writes atomically) and prints an `export BIFROST_VK=…`
line. It does NOT edit your shell profile — paste the export lines into `~/.zshrc` /
`~/.bashrc` yourself:

```bash
echo 'export BIFROST_URL=https://<your-gateway-host>/mcp' >> ~/.zshrc   # or ~/.bashrc
echo 'export BIFROST_VK=vk_<your-key>' >> ~/.zshrc
source ~/.zshrc
```

Restart Claude Code. Done.

### Inside Claude Code (after the plugin is installed)

```
/bifrost-setup
```

Or type **"set up bifrost"** — the `bifrost-onboard` skill takes over.

> macOS note: Claude Code launched from the Dock or Spotlight does NOT inherit
> `~/.zshrc` exports, so `BIFROST_VK` will be empty and the gateway gets no key.
> Launch CC from a terminal, or set the env vars via a launchd plist.

---

## Requirements

- Node.js >= 18
- Claude Code with MCP support
- `BIFROST_URL` set to your gateway's `/mcp` endpoint
- `BIFROST_VK` set to your virtual key (from your gateway operator)
- A memory service reachable at `${BIFROST_MEMORY_URL}` (default `http://127.0.0.1:52421`) for memory features (Pillars 1 + 4). Without it, memory injection and reflection silently no-op — the gateway and skill discovery still work.

---

## Skills

| Skill | Trigger |
|-------|---------|
| `bifrost-onboard` | "set up bifrost", "onboard me to bifrost", "install bifrost gateway" |
| `bifrost-debug` | "bifrost not working", "mcp not connecting", "memory not injecting" |
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

`${BIFROST_URL}` and `${BIFROST_VK}` are resolved at runtime from your shell
environment. The key is never stored in any file.

---

## Troubleshooting

**401 / 403 from bifrost** — `BIFROST_VK` is missing or wrong. Re-export it.

**No memory injection** — the memory service is not running on `${BIFROST_MEMORY_URL}` (default `127.0.0.1:52421`). Both hooks silent-fail so prompts continue normally; only enrichment is skipped.

**Skill-search tool not found** — bifrost MCP not loaded, or your gateway exposes no skill server. Check `~/.claude/mcp.json` has the bifrost entry and restart Claude Code.

**Hooks not firing** — the hooks ship inside the plugin (`hooks/hooks.json`), not `~/.claude/settings.json`. Confirm the plugin is installed and enabled via `/plugin`, then restart Claude Code.

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
SessionStart  →  session-start.cjs  →  prints guidance/bifrost-context.md (~400 tokens),
                                        then drains staging/ → POST /memory/store → processed/
UserPromptSubmit  →  prompt-submit.cjs  →  (A) memory enrich + (B) skill-discovery hint
Stop  →  session-reflect.cjs  →  stages session learnings to staging/ (Pillar 4 flywheel)

~/.claude/mcp.json  →  bifrost MCP server  →  mcp__bifrost__<server>-<tool> (skills, memory, …)
```

All hooks silent-fail: any network error, service-down, or parse failure exits 0 silently so they never block a prompt.

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

# 3. Clean the local cache (staging / processed / reflected):
rm -rf ~/.cache/bifrost-plugin/

# 4. Remove 'export BIFROST_URL=...' / 'export BIFROST_VK=...' from ~/.zshrc / ~/.bashrc if you added them.
```

---

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 neXenio GmbH.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
