# Plugin wakes need event ids, a group key, acks and an atomic settle

- found: 2026-10-26, plan: 20261026-loremax-wake-per-conversation, phase: planning
- severity: major
- area: bridex host server/src/plugins/types.ts (`wakeAgent`), server/src/plugins/host.ts:153, server/src/core/wakeups.ts:45
  (affects loremax, fal, elevenlabs, host media_video)

Two agent field reports (Pixelverse slice-art, Pixelverse audio + hero icons): an agent that ran 25–36 generations got one
"generation finished" run per generation, each re-reading the whole context to answer NO_REPLY — while the batch was
still running, and after the agent had already collected every result with `loremax_result` and closed the task.

0.4.1 cuts the noise in the plugin by sharing one wake key per conversation, so wakes queued while the agent is busy
merge (`enqueueWakeup` concatenates a pending row's prompts). That does not cover:

- **Consumed results.** Once a wake is queued, nothing can retract it: `ctx.wakeAgent` has no cancel, and a merged
  prompt cannot lose one line. The plugin could delete its own pending rows through `ctx.db` (host.ts:117), but that
  ties it to the queue's schema.
- **An idle agent.** The first wake is claimed at once, so finishes that land seconds apart still run separately.
  `wakeAgent` takes no `notBefore`.
- **Lost wakes.** The plugin settles the job row, then calls `wakeAgent` (index.mjs:1260, then the watcher's wake):
  a crash between the two leaves a saved result with no wake.
- **Key scope.** The coalescing lookup matches `(key, agent, pending)` without the workspace (wakeups.ts:45), and the
  merged payload's other fields are overwritten by the last enqueue. Restart recovery moves `processing` back to
  `pending` (wakeups.ts:~278), so one key can have two pending rows.
- **Retry budget.** A wake whose run failed transiently (usage limit, 429) goes back to `pending` with a backoff
  `notBefore` and its `attempts` (wakeups.ts:~220). A merge into it resets `notBefore` to now but keeps `attempts`
  (wakeups.ts:~72), so with the shared key every LoreMax finish during a usage-limit window reruns the merged row at
  once and spends one retry; after `wakeup_retries` the row fails and takes every merged line with it. With per-row
  keys each finish had its own budget and backoff. Fix in the host: a merge into a row with `attempts > 0` either
  keeps its `notBefore` or starts a fresh budget. (found in internal review of 0.4.1, 2026-10-26, severity major)

Suggested direction, for all plugins at once: give each plugin event its own id plus a group key; let a plugin ack an
event (its result reached the recipient, e.g. through `loremax_result`) so the executor drops acked events before a
run; write the job settle and the wake event in one transaction; optionally a debounce window per group. Plugin wakes
for a task could carry `taskId` too, but the executor's closed-task skip covers `done`/`cancelled` only, not
`in_review`, and a FAILED notice on an in-review task can still matter — do not drop those.
