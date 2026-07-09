# Bifrost in Claude Desktop — temporary setup

Claude Desktop can't yet connect to the Bifrost gateway on its own (no zero-config
login) — proper OAuth support is in progress on a separate branch. Until that ships,
this page gets you connected in about a minute using a small local bridge.

## Step 1 — Get your personal virtual key

Visit **[bifrostphil108.share.zrok.io](https://bifrostphil108.share.zrok.io)**, sign
in, and copy your personal virtual key (starts with `vk_`). Keep it private — like a
password. Don't post it in Slack, email, or paste it anywhere other than the prompt
in Step 2.

## Step 2 — Paste this one command into Terminal

Open **Terminal** (Spotlight → "Terminal") and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-quickstart/setup.sh | bash
```

It will ask for your virtual key:

```
Virtual key (vk_..., input hidden):
```

Paste the key from Step 1 and press Enter — nothing appears on screen as you type or
paste, that's normal (it's never written to your shell history this way).

If you don't have Node.js installed, the script installs it automatically (no admin
password needed) — the first run may take a minute or two longer because of this.

**One-time, first ever MCP use in Claude Desktop:** if you've never connected an MCP
server before, also enable it under **Claude Desktop → Settings → Developer**.

## Step 3 — Restart & verify

1. Fully quit Claude Desktop (Cmd+Q, or Claude menu → Quit — not just closing the
   window).
2. Reopen Claude Desktop.
3. Look for the hammer/tools icon in the chat input.
4. Ask: *"What bifrost MCP tools do you have?"* — you should see tools whose names
   contain something like `lucaskills`.

## Alternative — if you already have Claude Code

Paste this into a Claude Code chat instead:

> I need help connecting our company's Bifrost MCP gateway to Claude Desktop on my
> Mac. I am not a developer — guide me one step at a time and wait for my reply
> before continuing.
>
> Do NOT show me a Terminal command until I've confirmed I have my virtual key. Do
> NOT ask me to paste my virtual key into this chat.
>
> Step 1: tell me to open https://bifrostphil108.share.zrok.io, sign in, and copy my
> personal virtual key (starts with `vk_`). Wait for me to confirm I have it.
>
> Step 2: once I confirm, ask me for the key directly in this chat (this is safe —
> it's only used in your tool call, not saved to my shell history), then run this
> using your Bash tool with my key substituted in for `<key>`:
> `curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-quickstart/setup.sh | bash -s -- --key <key>`
>
> Step 3: tell me whether it succeeded, then remind me to fully quit and reopen
> Claude Desktop, and to ask it "What bifrost MCP tools do you have?" to verify.

## Troubleshooting

**"no valid virtual key provided"** — you didn't enter a key at the prompt, or it
looked like a leftover placeholder. Get one from
https://bifrostphil108.share.zrok.io and run the command again.

**Node install failed** — install manually from [nodejs.org](https://nodejs.org/)
(LTS version), then run the command again.

**401 / 403, or Claude says the tools aren't working** — your key may be wrong or
expired. Get a fresh one from https://bifrostphil108.share.zrok.io and re-run the
command (safe to run more than once).

**No hammer icon after restarting** — make sure Developer mode is enabled
(Settings → Developer) and that Claude Desktop was fully quit, not just
window-closed. Quit again from the menu bar, then reopen.

**`curl: (22) ... 404`** — the setup script may not be available at that URL yet;
check with your gateway operator.

## Security

- Your key is stored only in
  `~/Library/Application Support/Claude/claude_desktop_config.json` on your Mac
  (permissions restricted to your account).
- The setup script is fetched over HTTPS from GitHub — only run it from the official
  repository URL shown above.
- Never share that config file or your `vk_...` key with anyone.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-quickstart/setup.sh | bash -s -- --uninstall
```

## This is temporary

Once OAuth support for the gateway is live, Claude Desktop will connect with zero
setup like this — you'll use **Settings → Connectors** instead and can remove the
local `bifrost` entry this script created. This directory goes away at that point;
ask your gateway operator if you're not sure whether that's already happened.
