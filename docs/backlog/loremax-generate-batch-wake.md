# One wake for a whole batch of loremax_generate calls

- found: 2026-10-26, plan: 20261026-loremax-wake-per-conversation, phase: planning
- severity: minor
- area: index.mjs (`loremax_generate`, watcher `watchOnce` ~2600, `settleLate` ~2296, `waitFor` ~2501)

An agent that fires a batch in parallel and needs the whole batch for its next step is woken once per generation when
it is idle (the shared per-conversation key only merges wakes queued while it is busy). Proposal from the field: an
optional `batch` / `wake_when` key on `loremax_generate`, so a batch of N costs one wake.

A free-form `batch: "<label>"` checked as "no pending row with this label left" is not reliable (review, 2026-10-26):

- the batch has no closed membership: a placeholder row is created only after async reference hashing
  (index.mjs:2369), so "nothing pending" can be a gap between parallel calls;
- `jobs.settle` replaces the row's `result`, dropping the tracked params (host.ts:191), and `pending()` returns
  running rows only — the members and their result lines need their own persisted registry;
- generations finish through four paths (watcher, inline generate/result, late submit `settleLate`, past-deadline save
  in `waitFor`): all must report to one completion handler, or the last member finishes with no one to send the wake;
  a placeholder that becomes a generation (`adopt`, index.mjs:2227) is one member, not two;
- a failed save leaves the job `running` and needs the agent now: never hold it for the batch.

Suggested direction: build it after the host work in `host-plugin-wake-events.md` (group key + acks). Either register
all members up front (one call with a list of generations) or give the agent an explicit "close batch <id>" step.
Rejected: a `no_wake` flag plus a separate "wake me when these ids land" call — a forgotten follow-up loses results
silently, and a detached `submitting` submission has no generation id yet.
