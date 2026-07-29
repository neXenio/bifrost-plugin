# Security policy

## Reporting a vulnerability

Report security issues privately via [GitHub Security Advisories](https://github.com/neXenio/bifrost-plugin/security/advisories/new)
rather than a public issue. We aim to acknowledge within five working days.

## What this plugin touches

Worth knowing when assessing a report:

- **Credentials.** The hooks resolve a gateway URL and virtual key from
  `BIFROST_URL`/`BIFROST_VK`, or from the MCP server entry in `~/.claude.json` when the
  environment does not carry them. URL and key are always taken from the *same* source
  — never one from each — so a stale environment variable cannot pair with a
  configured key and send it to an unintended host. The key is never written to stdout;
  the gateway URL is reduced to scheme, host and path before being printed, because an
  MCP endpoint may legitimately carry credentials in userinfo or the query string.
- **Context injection.** Everything the hooks emit on stdout becomes model context and
  is sent to your model provider. Content recalled from a shared memory server is
  wrapped in an explicit untrusted-data boundary so a stored value shaped like an
  instruction is not read as one.
- **Local state.** `~/.cache/bifrost-plugin/` holds discovery, recall and usage caches.
  The usage counter records tool-name classes and success/failure counts only — no
  queries, arguments, results or prompts — and never leaves the machine.
- **Project state.** The `Stop` hook creates `<project>/.bifrost/` for locally recorded
  memory candidates, with a self-ignoring `.gitignore` so nothing reaches a commit.
- **Admin policy** is fetched as an Ed25519-signed bundle and verified before use, with
  the signing key pinned on first use by key id. A bad signature leaves the last
  verified configuration in place rather than applying anything.

## Scope

In scope: credential handling, anything reaching model context, signature verification,
and hook behaviour that could block or hang a session.

Out of scope: the Bifrost gateway itself and any MCP servers behind it — those are
separate deployments. Report those to whoever operates your gateway.
