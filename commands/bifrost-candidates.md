---
description: Review memory candidates recorded during sessions, and promote the good ones into shared team memory.
---

# /bifrost-candidates

Review the findings this project's sessions recorded, and decide which become shared
team knowledge.

Candidates live in `.bifrost/candidates.md` in the project root (git-ignored). They are
written by the Stop hook's periodic memory check-in and are **local and unreviewed** —
nobody else can see them, and nothing reads them automatically. This command is that
reader.

## Why this step exists

The shared corpus has no read permission model. `memory_search` does take filters —
`wing`, `room`, `tier`, `agent_id`, `conversation_id`, `include_expired` — but every one
of them is the caller's own retrieval narrowing, chosen per query and dropped just as
easily on the next one. Nothing a writer can set keeps an entry away from a reader. So
anything written to the corpus is recalled by every colleague immediately, as settled
team knowledge. Combined with correction machinery that exists but has never once been
used, a wrong entry is effectively permanent. Shared submission is therefore deliberate,
privacy-gated, and governed by the collective server workflow—not automatic retrieval.

## Procedure

**1. Read the file.** If `.bifrost/candidates.md` does not exist or holds only its
header, say so and stop — nothing has been recorded here yet.

**2. Summarize.** List each candidate with its date. Group near-duplicates; the same
finding often gets recorded by more than one session.

**3. Triage each one.** For each candidate, judge:

- **Still true?** Check it against the current code. A finding recorded three weeks ago
  may already be stale, and stale is the failure mode that matters most here.
- **Durable, or transient?** A convention or root cause is worth keeping. "Fixed the
  auth test" is not.
- **General, or session-specific?** It must make sense to someone who was not there.
- **Safe to share?** No secrets, credentials, customer or personal data. Everything
  promoted is recalled into colleagues' prompts and therefore sent to the model
  provider — treat it as publishing to the whole company.
  Run the classification check in `guidance/memory-classification.md` before promoting
  anything. First failing gate decides; when unsure, leave it in the spool.

**4. Present your recommendation** as keep / drop / needs-editing, with one line of
reasoning each. Any agent may submit an eligible team fact, but the server—not this
local file—governs collective promotion. Do not submit content that fails the privacy
gate or needs a human decision.

**5. Submit the eligible ones.** For each, first check the advertised schema, then
call the memory server's `memory_store` (spelled as your SessionStart context shows it
for this gateway). luca-memory v0.40 requires:

- `subject` — the entity the claim is about, such as a project, service, or convention.
- `valid_from` — when the claim became valid in ISO 8601. Use an earlier known validity
  time when the finding provides one; otherwise use the current time.
- `text` — the finding rewritten as one clean, self-contained claim. Prefer this over
  pasting the raw bullet.

`tenant` was removed. A stale Bifrost catalog may still advertise it, but it is an
ignored compatibility input—never invent a tenant value or treat it as a privacy scope.

In a correctly wired collective Bifrost deployment, the store returns
`{"status":"pending","candidate_id":"..."}`. That is a durable server-side
candidate with the submitting user's first vote, **not** a promoted or searchable fact.
Keep the `candidate_id` with the local entry as a reference, but do not treat the local
spool as the authoritative ledger. The v0.40 service does not yet expose the full
cross-user resolution workflow, so flag any candidate that needs follow-up rather than
claiming it was promoted.

`{"status":"queued"}` is a local/private queued-ingest acceptance, and
`{"status":"stored"}` is an immediate local/private write. If the Bifrost shared
deployment returns either, stop and ask the gateway operator to verify collective mode
and trusted VK-identity injection before treating it as company knowledge.

**6. Prune only dropped or completed local entries.** Keep collective `pending` entries
with their `candidate_id` until their server-side outcome is available. Do not mark a
pending candidate as promoted merely because it was accepted by `memory_store`.

## Notes

- If a candidate contradicts something already in shared memory, say so explicitly.
  The corpus has no correction path of its own, so a contradiction is a decision for
  the user, not something to resolve silently.
- If a candidate describes a task the skill library had no procedure for, that is a
  better fit for a new skill than a memory fact. Flag it as such.
