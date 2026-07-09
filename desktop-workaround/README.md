# Claude Desktop workaround (local bridge)

Temporary **macOS** package until server-side OAuth is deployed. Coworkers download one script from GitHub — no git checkout.

**Repo:** [github.com/neXenio/bifrost-plugin](https://github.com/neXenio/bifrost-plugin) → `desktop-workaround/`

## Coworker flow

URLs: [company-urls.md](./company-urls.md) (IT updates here first; keep GUIDE/PROMPT in sync).

1. Get virtual key: https://bifrostphil108.share.zrok.io  
2. Download and run (key prompted securely — not on command line):

```bash
curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-workaround/setup.sh \
  -o ~/bifrost-desktop-setup.sh
chmod +x ~/bifrost-desktop-setup.sh
~/bifrost-desktop-setup.sh --url https://bifrostadmin108.share.zrok.io/mcp
```

See [GUIDE.md](./GUIDE.md) · [PROMPT.md](./PROMPT.md)

## How it works

```text
~/bifrost-desktop-setup.sh --url …
    → ensure Node 18+ (~/.local if needed)
    → resolve absolute path to npx (Claude Desktop GUI PATH)
    → prefetch mcp-remote
    → write ~/Library/Application Support/Claude/claude_desktop_config.json

Claude Desktop  --stdio-->  /path/to/npx mcp-remote  --HTTP+x-bf-vk-->  Bifrost /mcp
```

## Files

| File | Role |
|------|------|
| `setup.sh` | Entry point (download to ~/bifrost-desktop-setup.sh, then run) |
| `bin/install-desktop.js` | Config writer (auto-fetched when not running from repo checkout) |
| [GUIDE.md](./GUIDE.md) | Non-dev instructions |
| [PROMPT.md](./PROMPT.md) | Copy-paste Claude Desktop prompt |
| [company-urls.md](./company-urls.md) | Gateway + key-site URLs (**IT: update here first**) |

## Local / branch testing

From a repo checkout:

```bash
./desktop-workaround/setup.sh --url https://bifrostadmin108.share.zrok.io/mcp
```

Before merge to `master`, point raw URLs at your branch:

```bash
export BIFROST_DESKTOP_RAW_BASE=https://raw.githubusercontent.com/neXenio/bifrost-plugin/feature/desktop-workaround/desktop-workaround
curl -fsSL "$BIFROST_DESKTOP_RAW_BASE/setup.sh" -o ~/bifrost-desktop-setup.sh
```

## Security

- Virtual key: prompted with `read -s` (not on command line when using recommended flow)
- Config: `~/Library/Application Support/Claude/claude_desktop_config.json` (`chmod 600`)
- Scripts fetched over HTTPS from GitHub; Node bootstrap uses [install-node.vercel.app](https://install-node.vercel.app) when needed
- Cached installer: `~/.cache/bifrost-desktop-workaround/install-desktop.js`

## Replace with OAuth later

When OAuth is live, coworkers use **Settings → Connectors** and remove the local `bifrost` entry.
