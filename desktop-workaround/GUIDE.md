# Connect Bifrost to Claude Desktop (temporary guide)

**For coworkers — no engineering background needed.**

Temporary workaround until company OAuth login for Claude Desktop is ready. One Terminal command configures a local bridge so Claude can use your personal virtual key.

Scripts: [neXenio/bifrost-plugin](https://github.com/neXenio/bifrost-plugin) (`desktop-workaround/`). No git checkout.

**Company URLs** (IT updates [company-urls.md](./company-urls.md) when hosts change):

| What | Where |
|------|--------|
| **Get your virtual key** | https://bifrostphil108.share.zrok.io |
| **Gateway (for setup command)** | `https://bifrostadmin108.share.zrok.io/mcp` |

> **Later:** `bifrost-setup.luca-app.de` (keys) and `bifrost.luca-app.de/mcp` (gateway).

---

## One-time: enable Developer mode

If you have never used MCP in Claude Desktop:

1. **Claude Desktop** → **Settings** → **Developer**
2. Turn on developer / MCP support

---

## Setup (three steps — do them in order)

### Step 1 — Get your virtual key

1. Open **https://bifrostphil108.share.zrok.io** in your browser
2. Sign in and copy **your** virtual key (`vk_…`)
3. Keep it private — like a password. Do not post it in Slack or email.

Do **not** continue until you have your key copied.

### Step 2 — Confirm the gateway URL

Unless IT gave you a different address, your gateway is:

```text
https://bifrostadmin108.share.zrok.io/mcp
```

If IT gave you another URL, use theirs — it must end with `/mcp`.

### Step 3 — Run the setup script

**Only after Steps 1 and 2.** Open **Terminal** (Spotlight → “Terminal”).

The commands below download the script once, then run it. The script **asks for your virtual key with hidden input** — it is not typed on the command line (so it does not land in shell history).

```bash
curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-workaround/setup.sh \
  -o ~/bifrost-desktop-setup.sh
chmod +x ~/bifrost-desktop-setup.sh
~/bifrost-desktop-setup.sh --url https://bifrostadmin108.share.zrok.io/mcp
```

When prompted `Virtual key (vk_…, input hidden):`, paste your key from Step 1 and press Enter. You will not see characters as you type — that is normal.

First run may take a few minutes (Node install + downloads).

**Preview only** (does not change anything):

```bash
~/bifrost-desktop-setup.sh --url https://bifrostadmin108.share.zrok.io/mcp --dry-run
```

(still prompts for your key, or pass `--key` only for dry-run previews)

### Prefer help from Claude?

Use the [copy-paste prompt](https://github.com/neXenio/bifrost-plugin/blob/master/desktop-workaround/PROMPT.md) — Claude walks through Steps 1–3 and uses the same download-and-run flow.

---

## Restart Claude Desktop

Fully **quit** Claude Desktop (menu → Quit), then reopen. Closing the window is not enough.

---

## Verify

1. New chat → look for the **hammer icon** (MCP tools)
2. Ask: **“What bifrost MCP tools do you have?”**

You should see gateway tools (e.g. names containing `lucaskills`).

---

## Troubleshooting

| Problem | What to try |
|--------|-------------|
| Used `PASTE_YOUR_VK_HERE` or a placeholder | Run setup again; paste your real `vk_…` at the prompt |
| Wrong key / tools don’t work | Get a fresh key from https://bifrostphil108.share.zrok.io |
| `curl: (22) … 404` | Ask IT — setup scripts may not be on GitHub yet |
| No hammer icon | Developer mode (above); quit & reopen Desktop |
| Node install failed | [nodejs.org](https://nodejs.org/) then re-run setup |

---

## Security

- Key lives only in `~/Library/Application Support/Claude/claude_desktop_config.json` on your Mac
- The setup script is downloaded from GitHub over HTTPS — only run it from the official repo URL above
- Never share that config file or your `vk_…` key

---

## When OAuth is ready

IT will announce. Use **Settings → Connectors** and remove the local `bifrost` MCP entry.
