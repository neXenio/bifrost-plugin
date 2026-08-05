# Memory classification: what may enter the shared corpus

Promotion is publication. A fact promoted into the shared memory corpus is:

1. **Sent to your model provider.** It is recalled into other engineers' prompts, which
   means it leaves the machine and leaves the company boundary on every recall.
2. **Read as settled knowledge by every agent with a key.** There is no read permission
   anywhere in the path — no per-team, per-role or per-tier ACL. `memory_search` does
   take filters (`wing`, `room`, `tier`, `agent_id`, `conversation_id`,
   `include_expired`), but those are the *caller's* retrieval narrowing: chosen per
   query, and dropped just as easily on the next one. A filter the reader picks is not a
   permission the writer sets. There is no restricted shelf to put something on.
3. **Effectively permanent.** The correction machinery exists and is entirely unused.
   The graph defines `SUPERSEDES`, `SUPERSEDES_MEMORY` and `CONTRADICTS` edge types and
   all three sit at zero; `memory_search` exposes `include_expired` over a `valid_to`
   field, so every hit already reports whether it is expired;
   `memory_call(action="evolve.purge_noise")` tombstones cards. (Inspecting a memory,
   `meta.inspect`, is not one of these: it returns the neighbourhood for the caller to
   re-store, it does not delete.) None of it has
   ever been used: the corpus has still never recorded a correction. An unexercised
   correction path is not a working one, so assume you cannot take it back.

That first point is the sharpest line, and it is what this rule is built around. Everything
below is downstream of it.

This page is applied by a person or an agent at exactly one place: **step 3 of
`/bifrost-candidates`**, before anything is stored. It should take about ten seconds per
candidate.

## Three dispositions

- **Promote.** Store it, rewritten as one self-contained, dated claim.
- **Redact, then promote.** The lesson is worth keeping, the wording is not. Promote the
  rewrite, never the original.
- **Do not promote.** Discard it, or route it somewhere that has an audience control (an
  issue, an MR, a local doc). The candidate spool is local and git-ignored, so leaving
  something unpromoted costs nothing but one future rediscovery.

## The check

Run in order. First match wins, stop there.

| # | Ask | If yes |
|---|-----|--------|
| 1 | Does it contain a credential, token, key, or any value that authenticates something? | **Do not promote.** Also remove it from the spool in the same pass: that file is plaintext on disk. Do not repeat the value in your review output. |
| 2 | Does it identify a person? Customer, guest, employee, partner contact. Names, emails, phone numbers, account or booking references, IP addresses, free-text that describes one individual. | **Redact** to a role or a class, or do not promote. |
| 3 | Does it describe a security weakness that is not fixed yet? | **Do not promote.** See below, this one has its own rule. |
| 4 | Is it commercially confidential? Contract terms, provider fees, pricing, negotiation state, anything under an NDA. | **Redact** to the technical constraint, or do not promote. |
| 5 | Is it legal, privileged, or regulatory work in progress? Counsel advice, audit findings, correspondence with a regulator or a customer about an incident. | **Do not promote.** |
| 6 | None of the above. Is it durable, general and still true? | **Promote.** |

Gates 1 to 5 are about harm. Gate 6 is about usefulness, and `/bifrost-candidates` already
covers it in its existing triage (still true, durable, general). This page adds 1 to 5 and
defers 6 to the command.

## What a clean promote looks like

The content this corpus is for, and which passes every gate by construction:

- A decision and the reasoning behind it, especially one a future reader would otherwise
  reverse without knowing why.
- A root cause, together with the symptom that led to it.
- A convention, constraint or gotcha that is not obvious from reading the code.
- A correction of something wrong in the corpus or the docs.
- A task that the skill library had no procedure for, flagged as a skill gap.

That list is the same one the `Stop` hook uses when it collects candidates. If a candidate
does not resemble one of these, the question is usually not classification but whether it
is worth promoting at all.

## Unfixed security findings

**An unfixed finding does not go in the corpus.** Not redacted, not "for the team", not
with a warning label.

Three reasons, and each one is sufficient:

- **The corpus cannot express a restricted audience.** Every key holder reads everything,
  because nothing in the path enforces a read permission — only the retrieval filters a
  caller chooses for themselves, and a caller who wants everything simply omits them.
  "Share it with the people who can fix it" is not a thing the corpus can do, so promoting
  a finding means telling everyone, including whatever sits on the other side of the
  provider boundary, where a live weakness is and how to reach it.
- **It is the most perishable class of fact in a store that has never once corrected
  itself.** After the fix ships, the entry still reads as current. That is worse than not
  having it: it points a reader at a thing and is wrong about whether it works.
- **The people who need it are a known, small list.** They are reachable directly. A
  broadcast channel is a bad fit for a message with three recipients.

While a finding is unfixed it belongs in the tracker with restricted visibility, in the MR
that fixes it, or in a local file. Two things may go into the corpus instead:

- **The forward-looking convention, stated positively, naming no target.** "Role and
  permission maps must be keyed on a key's stable identifier, never on the key's secret
  value, so the map is not itself a credential store." That is a durable engineering rule.
  It teaches the lesson without saying that any particular system is currently wrong.
- **After the fix is deployed, a past-tense entry with the date and the lesson, and no
  reproduction path.** "Until 2026-08 the role map was keyed on the secret value; it is now
  keyed on the id. Do not reintroduce the old shape." Useful, and no longer actionable by
  anyone who reads it in bad faith.

## Redaction

The convention is one sentence: **keep the mechanism and the lesson, drop the identifier,
the value and the reproduction path.**

Two rules that carry most of the work:

- **Point, do not copy.** A ticket key, a file path or an MR link is a pointer, and it
  inherits whatever access control that system has. Pasting the contents of one into the
  corpus strips that control away. Cite the record, do not reproduce it.
- **Date everything.** A promoted fact with no date cannot be judged stale, and staleness is
  the failure mode this corpus is worst at.

### Example 1: a configuration finding carrying a credential

Before:

> Gateway auth works with header `x-bf-vk: vk_<value>` against `https://<host>/mcp`. Hooks
> have to read it out of the MCP client config because the env vars are empty.

After:

> Claude Code hook processes do not inherit the MCP server's credential. It lives in the MCP
> client config, so hook code must resolve the URL and the key from that same source, never
> one from the environment and one from config. Verified 2026-07-28.

The mechanism is the entire lesson. The key value and the host add nothing for a reader who
has their own, and the key is the one class of content that turns a memory store into a
credential store.

### Example 2: a payments root cause carrying customer data

Before:

> Payout for merchant "Hotel Beispiel" (contact a.muster@example.com, ticket ABC-1234) failed
> after their bank connection was changed. The queued row still referenced connection id
> 88214.

After:

> Changing a merchant's bank connection does not re-point payouts that are already queued:
> they keep the previous connection reference and fail at execution. Drain or re-point queued
> payouts before switching a connection. Seen 2026-07, ticket ABC-1234.

The ticket key stays, as the pointer. The merchant, the contact and the row id go. Anyone
with tracker access can still get to the specifics; the corpus does not need to carry them,
and the model provider does not need to see them.

### Example 3: an integration note carrying contract terms

Before:

> Provider A takes <x>% + <y> per transaction and provider B takes <z>% under the 2026
> contract, so route high-value bookings through B.

After:

> Per-transaction fees differ by payment provider and by contract period, so nothing
> downstream may hardcode a rate. Read it from the provider configuration. The rates
> themselves are contract material and stay out of shared memory.

The engineering constraint survives, the commercial term does not. The last sentence is
deliberate: it tells the next person why the numbers are missing, so nobody helpfully adds
them back.

## When it is genuinely unclear

**Default: do not promote.** Leave the candidate in the spool, say so in the review output,
and name the gate you were unsure about.

The asymmetry is the whole argument. An unpromoted fact costs one rediscovery. A wrongly
promoted one is company-wide, has left for the provider, and in practice cannot be undone.
Those are not the same size of mistake, so the tie does not go to promotion.

Who decides when the reviewer is unsure:

- Privacy, personal data and regulatory questions: the person who owns data protection.
- Unfixed findings: the owner of the affected system, together with the corpus owner.
- Everything else, and any tie: the corpus owner.

**Placeholder:** these are roles, not names. Fill them in below before treating this as
binding.

## How this binds to `/bifrost-candidates`

The check runs in **step 3, triage**, alongside "still true", "durable" and "general". The
command's existing "safe to share?" bullet is this rule compressed to one line; this page is
what it expands to.

An agent running the command must:

- Report a gate failure explicitly, naming the gate. Do not silently drop a candidate: the
  user should see what was rejected and why.
- Propose the redacted version when there is one, and show the user both. Never promote a
  redaction without the original in view.
- Treat a gate 1 failure differently from the rest: report it, rewrite the spool to remove
  the value in the same pass, and do not echo the value.
- Still prune. A rejected candidate is resolved, so step 6 applies to it like any other.

## Enforcement, honestly

**This is a rule that people and agents apply. It is not a control.** Nothing in this plugin
refuses a bad write, and this page does not change that.

It is weaker than that even. The chokepoint is not here: anyone with a key can call the
memory store tool from any client, including Claude Desktop over OAuth and any scheduled
automation. Whatever this plugin enforces covers only the sessions that run through this
plugin.

Could be made technical, roughly in order of value per effort:

- **Secret-shaped string detection** over the spool and over the arguments of a store call.
  High signal, few false positives, and it catches the worst class outright. A `PreToolUse`
  hook matched to the memory server's store tool can block the call rather than warn.
- **Pattern detection** for email addresses, phone numbers, IBANs and card-shaped digits.
  Noisier, still worth it as a warning rather than a block.
- **A required date** on every promoted fact. Trivially checkable, and it makes staleness
  visible later.
- **A gateway-side write filter on the memory server.** This is the only version that is a
  real control, because it is the only one that covers every client. Everything above is a
  speed bump on one path.

Cannot be made technical, and stays a judgement:

- Whether something is commercially confidential.
- Whether a security finding is actually fixed.
- Whether a person named in a sentence is fine with being in there.
- Whether the claim is true.

## Placeholders, for the corpus owner to resolve

Unverified at the time of writing. Each one changes how this page should read.

1. **Names for the roles above.** Corpus owner, data protection owner, security escalation.
   Not set. Until they are, "ask the owner" resolves to nobody.
2. **Whether an existing internal data classification or information security policy
   applies.** Not verified. If one exists, this page must defer to it rather than compete
   with it. Treat this as a local operating rule until they are reconciled.
3. **Which model provider or providers the gateway routes to, whether a data processing
   agreement covers them, and whether retention is zero.** This determines what "sent to the
   provider" legally is. Note the direction: a favourable answer does not loosen gate 2, it
   only changes whether an accident is a disclosure or a documented transfer.
4. **Whether the corpus is listed in the record of processing activities.** Unknown. If
   personal data can reach it at all, it likely needs to be.
5. **Whether a promoted fact can actually be deleted or superseded.** The machinery is
   there; nobody has ever driven it, and nobody has tested what it does to recall. Four
   distinct things to test, because they fail differently:
   - **`valid_to` / `include_expired`.** Every hit reports `expired`, and the default
     search excludes expired facts. Test: can a fact's `valid_to` be set to the past
     after the fact, and does it then drop out of a default `memory_search`?
   - **`SUPERSEDES` / `SUPERSEDES_MEMORY` / `CONTRADICTS` edges.** All three edge types
     exist in the graph and all three sit at zero. Test: does writing one actually
     change what a plain `memory_search` returns, or is it inert metadata that only a
     graph query can see?
   - **`memory_call(action="evolve.purge_noise")`.** It tombstones cards. Test: is a
     tombstoned card gone from recall, and is it gone from the provider's side or only
     from this index? It applies immediately; there is no rehearsal mode.
     `meta.purge_noise_status` reports a sweep already running or finished, it does not
     preview one.
   - **`memory_call(action="evolve.edit")`.** It writes a correction, carries the
     original's links over, then retires the original — so the id changes, since ids are
     content-addressed. This is the first purpose-built correction path the corpus has
     had. Test: does the correction actually become the hit a plain `memory_search`
     returns, and is the original really gone from recall?
   - **`memory_call(action="meta.inspect")`.** Already answered, negatively: it returns
     the neighbourhood for the caller to re-store. It is not a delete and should not be
     counted as one.

   Until someone runs those, "permanent" above is the safe reading and should stay — an
   unexercised correction path is not a working one.
6. **Retention and re-review cadence.** None defined. A corpus that is never re-read
   accumulates stale facts that read as current.
