# Contributing

## Running the tests

Use a supported Node.js release (22.x, 24.x or 26.x). Run only the test files that
cover your local change. For example, for package or manifest changes:

```sh
node --test test/manifest.test.cjs
```

Pass additional explicit test paths when a change affects several components.
Reserve `npm test`, which runs the full suite, for GitHub Actions. The CI matrix
covers Node.js 22, 24 and 26 with read-only repository permissions.

No dependency installation or external service is needed for the tests: they spin
up loopback MCP stubs and drive the hooks as real subprocesses.

## What the tests are for

The hooks fail closed by design — every path is wrapped, and every hook exits `0` so a
broken plugin can never block a session. That safety has a cost: a defect produces
silence, not an error. The plugin once could not authenticate at all and looked
completely healthy for weeks, because the static guidance kept printing.

So tests here are expected to **exercise behaviour, not source text**. Asserting that a
file contains a string proves the string exists; it does not prove the feature works,
and it passes on an implementation that returns nothing. If you are tempted to
`readFileSync` a hook and regex it, drive the hook instead and assert on its output.

A quick way to check a test earns its place: break the code it covers on purpose and
confirm the suite goes red. Several tests in this repo were written, found to pass
against a deliberately broken implementation, and rewritten.

## Hook rules

- **Always exit 0.** Exit code `2` on `Stop` blocks a turn from ending; on
  `UserPromptSubmit` it blocks the prompt.
- **Never block on the network** in a synchronous hook. `SessionStart` reads caches and
  spawns a detached refresh; it must stay fast with a dead gateway.
- **Nothing on stdout that you would not want sent to a model provider** — that is where
  it goes. No credentials, and no unfenced content from a shared source.
- **Do not write outside `~/.cache/bifrost-plugin/`** except the project-local
  `.bifrost/` spool, which exists so appends do not trigger a permission prompt.

## Deployment specifics

Anything belonging to one organisation — gateway hostnames, retired endpoints, server
names — belongs in configuration, not in the source. See `BIFROST_LEGACY_HOSTS` and
`BIFROST_CANONICAL_URL` for the pattern.
