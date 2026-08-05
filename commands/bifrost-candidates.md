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
used, a wrong entry is effectively permanent. Shared submission is therefore deliberate
and privacy-gated—never automatic retrieval. luca-memory v0.42 removed the collective
review workflow that once staged submissions for a vote, so a store now lands in the
corpus directly. Nothing downstream will catch a bad entry; this gate is the only one.

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
local file—holds the shared corpus, so this spool is a staging area and never the
record. Do not submit content that fails the privacy gate or needs a human decision.

**5. Submit the eligible ones.** For each, first check the advertised schema, then
call the memory server's `memory_store` (spelled as your SessionStart context shows it
for this gateway). On luca-memory v0.42:

- `subject` — the entity the claim is about, such as a project, service, or convention.
- `text` — the finding rewritten as one clean, self-contained claim. Prefer this over
  pasting the raw bullet.
- `body` — optional markdown for anything longer than a fact. Recall stays fast on the
  short `text` and pulls the body up only when it is needed.
- `items=[...]` — optional, to submit several findings in one call. One rejected item
  does not discard the rest.

Read the advertised schema rather than this list. Do not send `valid_from`: the server
stamps its own UTC time, and one smuggled through is ignored, so there is nothing to
invent. `tenant`, `role` and `vk` are schema errors rather than ignored inputs — a
stale Bifrost catalog may still advertise them, but never invent a value or treat one
as a privacy scope.

Read what the store returns rather than assuming it landed. `{"status":"stored"}` is an
immediate write and `{"status":"queued"}` a queued-ingest acceptance; both mean the
claim is in. `{"status":"skipped","reason":"noise"}` means the noise classifier dropped
it — reread the text as if you had not written it, and only resend with `force=true`
if it really is a durable fact rather than status or telemetry.
`{"status":"skipped","reason":"near_duplicate"}` means an equivalent memory already
exists, so the knowledge is already in the corpus and there is nothing left to do.
`{"status":"error"}` means nothing was written; read the `error` field and fix what it
names before resending. Only a `{"status":"pending"}` reply means the memory server
is older than v0.42 and this plugin's calls are not landing:
say so rather than reporting the submission as done.

**6. Prune only dropped or completed local entries.** Keep an entry in the spool until
its store returned `stored` or `queued`. Do not mark one as promoted on the strength of
any other reply.

## Notes

- If a candidate contradicts something already in shared memory, say so explicitly.
  The corpus has no correction path of its own, so a contradiction is a decision for
  the user, not something to resolve silently.
- If a candidate describes a task the skill library had no procedure for, that is a
  better fit for a new skill than a memory fact. Flag it as such.
