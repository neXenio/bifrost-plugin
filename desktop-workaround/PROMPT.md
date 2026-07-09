# Copy-paste prompt for Claude Desktop

Copy **everything** in the block below into a **new Claude Desktop chat**.

Full guide: [GUIDE.md](https://github.com/neXenio/bifrost-plugin/blob/master/desktop-workaround/GUIDE.md)  
Company URLs (IT source of truth): [company-urls.md](https://github.com/neXenio/bifrost-plugin/blob/master/desktop-workaround/company-urls.md)

---

```
I need help connecting our company's Bifrost MCP gateway to Claude Desktop on my Mac. I am not a developer. Please guide me one step at a time and wait for my reply before continuing.

## Company defaults (use unless I say IT gave me something different)
See company-urls.md in the repo — currently:
- Virtual key site: https://bifrostphil108.share.zrok.io
- Gateway MCP URL: https://bifrostadmin108.share.zrok.io/mcp

## CRITICAL rules for you
- Do NOT show any Terminal command until I have confirmed Steps 1 and 2 below.
- Do NOT ask me to paste my virtual key into this chat. I will enter it only in Terminal when the script prompts me (hidden input).
- Do NOT put my virtual key on the command line (shell history risk).
- The gateway URL in the final commands must match company-urls.md unless I explicitly give a different one.

## Step 1 — Get my virtual key (you start here)
Tell me to open https://bifrostphil108.share.zrok.io in my browser, sign in, and copy my personal virtual key (starts with vk_). Remind me not to share it in Slack/email or paste it into this chat. Wait until I confirm I have copied it.

## Step 2 — Confirm gateway URL
Tell me the gateway is https://bifrostadmin108.share.zrok.io/mcp unless IT gave me another URL ending in /mcp. Wait for my confirmation.

## Step 3 — Run the setup script (ONLY after Steps 1–2 are done)
Give me these commands to run in Terminal. They download the script, then run it with the gateway URL only — the script will prompt me for my key with hidden input:

curl -fsSL https://raw.githubusercontent.com/neXenio/bifrost-plugin/master/desktop-workaround/setup.sh -o ~/bifrost-desktop-setup.sh
chmod +x ~/bifrost-desktop-setup.sh
~/bifrost-desktop-setup.sh --url "https://bifrostadmin108.share.zrok.io/mcp"

Explain that when it asks "Virtual key (vk_…, input hidden):" I should paste my key from Step 1 and press Enter (nothing will appear as I type).

Offer --dry-run only if I want a preview first:
~/bifrost-desktop-setup.sh --url "https://bifrostadmin108.share.zrok.io/mcp" --dry-run

## Step 4 — After the script runs
Tell me to fully quit Claude Desktop (Quit, not just close window) and reopen. Ask me to verify: "What bifrost MCP tools do you have?"

## If something fails
- Placeholder / wrong key → back to https://bifrostphil108.share.zrok.io, run setup again
- curl 404 → ask IT (scripts not on GitHub yet)
- No hammer icon → Settings → Developer → enable MCP, restart Desktop
```

---

## After setup

Start a fresh chat for normal work if this one mentioned your setup process.
