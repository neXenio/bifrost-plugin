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
used, a wrong entry is effectively permanent. Promotion is therefore a human decision,
not an automatic one.

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

**4. Present your recommendation** as keep / drop / needs-editing, with one line of
reasoning each. **Ask the user to confirm before promoting anything.** Do not promote
on your own judgement — that is the entire point of the file being local.

**5. Promote the approved ones.** For each, call the memory server's `memory_store`
(spelled as your SessionStart context shows it for this gateway) with the finding
rewritten as a single self-contained claim. Prefer editing to a clean, standalone
sentence over pasting the raw bullet.

**6. Prune what you promoted or dropped.** Rewrite `.bifrost/candidates.md` with only
the entries still pending, so the file does not grow without bound and the same
candidate is not reviewed twice.

## Notes

- If a candidate contradicts something already in shared memory, say so explicitly.
  The corpus has no correction path of its own, so a contradiction is a decision for
  the user, not something to resolve silently.
- If a candidate describes a task the skill library had no procedure for, that is a
  better fit for a new skill than a memory fact. Flag it as such.
