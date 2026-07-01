# Distribution guide — rolling bifrost-plugin out to a team

This covers what's needed to hand the plugin to a large team (e.g. 300 engineers)
and what must be true **on the gateway side** first. The plugin is deliberately
gateway-agnostic and safe-by-default; the gating work for a big rollout is
infrastructure, not the plugin.

## Plugin readiness (done — v1.0.0)

- **No secrets in the repo.** `.mcp.json` uses `${BIFROST_URL}` / `${BIFROST_VK}`
  env placeholders; each user supplies their own key. Verified by secret scan.
- **Ships disabled** (`defaultEnabled: false`) — installing does nothing until a
  user sets their key and enables it. No surprise connections.
- **Session start never blocks.** The SessionStart hook does zero synchronous
  network I/O: it reads a per-project cache (sub-ms) and spawns a detached worker
  to refresh it. A slow or down gateway adds ~0ms to startup (measured 0.04s with
  an unreachable gateway). This is the key property for shipping to many machines.
- **Self-wiring.** Enabling the plugin registers the `bifrost` MCP server from the
  shipped `.mcp.json`; no installer script required (one remains as a fallback).
- **Graceful degradation.** No key / no gateway / gateway missing a skills or
  memory server → those features simply no-op; Claude Code is unaffected.

## Per-user onboarding (what each engineer does)

1. `/plugin marketplace add neXenio/bifrost-plugin` then `/plugin install bifrost-plugin`
2. Add `BIFROST_URL` and their `BIFROST_VK` to `~/.zshrc` (see README).
3. `/plugin enable bifrost-plugin`, restart Claude Code.
4. Verify: `/mcp` lists `bifrost`; type "set up bifrost" / `/bifrost-debug` if not.

> macOS: CC launched from Dock/Spotlight does not inherit `~/.zshrc`. Launch from a
> terminal, or push the env vars via an MDM/launchd profile for fleet installs.

## Gateway prerequisites — REQUIRED before a 300-user rollout

These are **not** solved by the plugin and must be in place first:

1. **Production gateway, not a dev tunnel.** A single laptop behind a `zrok`/ngrok
   tunnel will not serve 300 users. Deploy bifrost on real infra (container/VM),
   with a stable DNS name, TLS, health checks, and restart-on-failure.
2. **Virtual-key provisioning at scale.** 300 personal `vk_…` keys need to be
   minted and distributed securely (secrets manager / MDM — never a shared key,
   never in the repo). Plan revocation/rotation.
3. **Memory/skill server capacity.** The memory server's `memory_search` degrades
   badly under concurrent load (ChromaDB contention: ~0.03s solo → ~20s at a
   handful of concurrent clients). At 300 users this must be addressed — e.g.
   scale-out / read replicas / a concurrency-tolerant vector store — or memory and
   skill-search calls will be slow. Note: the plugin's cached session-start hook is
   unaffected (it never waits), but **mid-session** `memory_search` / `skill_search`
   latency is bounded by gateway capacity.
4. **Rate limits / budgets per VK** so one user can't exhaust shared resources.
5. **Observability**: per-VK request metrics, error rates, gateway saturation.

## Suggested rollout

- **Pilot (5–10 engineers)** against the production gateway. Watch gateway
  saturation and `memory_search`/`skill_search` latency under real concurrency.
- **Waves** of ~30–50, monitoring gateway load between waves.
- **Full fleet** once latency holds under load.
- **Rollback**: `defaultEnabled: false` means new installs are inert; to pull back,
  push `/plugin disable bifrost-plugin` guidance or unpublish the marketplace entry.
  Nothing the plugin does is destructive to a user's environment.

## Go / no-go

- Plugin: **ready** (v1.0.0).
- Distribution to 300: **gated on gateway prerequisites 1–5 above.** Ship to the
  pilot first; do not fan out to 300 until the memory/skill server is proven under
  concurrent load.
