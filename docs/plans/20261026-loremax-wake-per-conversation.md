# LoreMax: one wake key per conversation

## Overview
- Every LoreMax wake now uses one key per conversation, `loremax-wake:<workspace>:<agent>:<sessionKey | service>`,
  instead of one key per job row or submission (`loremax-job:<row>`, `loremax-save:<row>`, `loremax-submit:<uuid>`).
- Problem: two agent field reports. An agent that ran 25–36 generations got one "generation finished" run per
  generation, each re-reading the whole context to answer NO_REPLY. In the second report the wakes kept coming after
  the agent had collected every result with `loremax_result` and closed the task. The watcher had queued them while the
  agent was busy, and distinct keys kept the host from merging them.
- Benefit: the host's `enqueueWakeup` already merges a pending wakeup with the same `(key, agent)` by concatenating
  prompts (bridex-studio `server/src/core/wakeups.ts:59`). With a shared key, every finish that lands while the agent's
  run is busy becomes one wake listing all of them: about 25 runs → 1 in the second report.
- Integration: one helper replaces the four `ctx.wakeAgent` call sites; it also keeps "one wake per generation" inside
  the process, which the per-row key used to give.
- Out of scope (filed in `docs/backlog/`): an idle agent still gets one wake per finish, queued wakes cannot be
  retracted after `loremax_result`, and settle-then-wake is not atomic (`host-plugin-wake-events.md`); the opt-in
  `batch` label (`loremax-generate-batch-wake.md`).

## Decisions
- **Context**: the plugin cannot debounce or retract a wake: `ctx.wakeAgent` has no `notBefore` and no cancel
  (bridex-studio `server/src/plugins/types.ts:245`). The host only merges wakes that are still pending.
- **Chosen approach**: a shared key per conversation (workspace + agent + session), so the host's existing merge does
  the work; a process-wide "already woke for this id" set keeps one wake per generation.
- **Rejected alternatives**:
  - a `batch` label on `loremax_generate` now: no closed membership, `settle()` drops the row's params, and four
    completion paths would need one handler — deferred until the host has group keys and acks (backlog);
  - `no_wake` plus a "wake me when these ids land" call: a forgotten follow-up loses results silently, and a detached
    submission has no generation id yet;
  - dropping wakes for `in_review` tasks: a FAILED notice can still matter there, and plugin wakes carry no `taskId`;
  - deleting the plugin's own pending wakeups through `ctx.db`: ties the plugin to the host queue's schema.
- **Verified facts**:
  - the coalescing lookup is `(key, agent, status = pending)` with no workspace (wakeups.ts:45), so the key must carry
    the workspace;
  - a merged row keeps the first prompt and appends each different one after a blank line; other payload fields come
    from the last enqueue — `sessionKey` is part of the key, so they cannot differ;
  - `sessionKey` can be absent: the host then runs the wake in the agent's service session for origin `api`
    (wakeups.ts:114), so `service` stands in for it in the key;
  - a finished generation the tool call saved itself is never woken by the watcher (it checks `find()` before saving,
    test/result-watcher.test.mjs:610), so wakes come only from detached saves and the watcher.

## Context (from discovery)
- Files/components involved:
  - `index.mjs`: `wakeSubmit` (~2213, key `loremax-${ph.submitId}`); the past-deadline save in `waitFor` (~2563, key
    `loremax-job:${trackedId}`); the watcher's `wake` (~2634, key `loremax-job:${j.id}`) and the save-failed wake
    (~2674, key `loremax-save:${j.id}`); process-wide sets via `globalThis[Symbol.for("bridex.loremax.…")]` (~1652, ~1658)
  - `test/helpers.mjs:53` (fake `wakeAgent` records into `rec.wakes`)
  - `test/generate.test.mjs:499-500, 640, 679` and `test/result-watcher.test.mjs:130, 163` assert the old keys
  - `README.md` (~440-545, the submit / background-save / watcher sections), `CHANGELOG.md`, `plugin.yaml:10`,
    `package.json` (version 0.4.0; a test keeps `PLUGIN_VERSION` in `index.mjs:88` equal to both)
- Related patterns found: process-wide state survives re-activation through `globalThis` symbols (`inFlight`,
  `submitting`); comments explain the why next to the code; tests use `node:test` and `setup()` fixtures.
- Dependencies identified: none new. Node ≥ 20, `npm test` (`node --test test/`).

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility: the wake prompts' text stays as it is; only the key changes

## Testing Strategy
- **Unit tests**: required for every task (see Development Approach above); `npm test`
- **E2E tests**: none in this project

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests and docs in this repository
- **Post-Completion** (no checkboxes): checking the merged wakes on a live Bridex studio
- **Checkbox placement**: only in Task sections

## Implementation Steps

### Task 1: Add the conversation wake helper and route the watcher through it
- [x] add `wakeKey({ workspace, agent, sessionKey })` in `index.mjs` → `loremax-wake:<workspace>:<agent>:<sessionKey || "service">`, with a comment on why the workspace is in it (the host's merge lookup has none)
- [x] add `wakeOnce(target, prompt, onceId)` in `activate`: skips an `onceId` already woken in this process (a `Set` under `globalThis[Symbol.for("bridex.loremax.woken")]`, like `inFlight`), else calls `ctx.wakeAgent?.({ workspace, agent, key: wakeKey(target), ...(sessionKey ? { sessionKey } : {}), prompt })`
- [x] route the watcher's `wake` (~2634) through it with `onceId` `job:<row id>`, and the save-failed wake (~2674) with `save:<row id>`; keep the prompts unchanged
- [x] update `test/result-watcher.test.mjs:130` and `:163` to the new key
- [x] write tests: two finished jobs of the same session share one key; jobs of another session, another workspace and another agent get different keys; a row without `sessionKey` gets the `service` key and no `sessionKey` in the wake
- [x] write tests: the same `job:<row id>` is not woken twice in one process (e.g. a second `watchOnce` after the row is reported pending again by a fake core without `find()`); a save failure followed by a successful save wakes twice (`save:` then `job:`)
- [x] run `npm test` - must pass before task 2

### Task 2: Route the submission and background-save wakes through the helper
- [x] route `wakeSubmit` (~2213) through `wakeOnce` with `onceId` `submit:<submitId>`, target from `ph.call`
- [x] route the past-deadline save wake in `waitFor` (~2563) with `onceId` `job:<trackedId>`, the same id the watcher uses for that row, and replace the "the watcher's key for this row" comment
- [x] update `test/generate.test.mjs:499-500, 640, 679` to the new key
- [x] write tests: a late submission (REST and profile) and a background save for the same session as a watcher-woken job share its key
- [x] write tests: a background save that woke for a row is not woken again by a following `watchOnce`; a late submission that fails still wakes (error path)
- [x] run `npm test` - must pass before task 3

### Task 3: Verify acceptance criteria
- [x] verify no `ctx.wakeAgent(` call is left outside `wakeOnce` (`grep -n "wakeAgent" index.mjs`)
- [x] verify every wake prompt is unchanged apart from its key (diff of the prompt template strings)
- [x] verify a core without `ctx.wakeAgent` still loads and blocks as before (existing older-core tests pass)
- [x] run full test suite (`npm test`)

### Task 4: [Final] Update documentation and version
- [ ] README.md: in the background-save / watcher sections, state that wakes share one key per conversation, so finishes that land while the agent is busy reach it as one wake; name what it does not cover (an idle agent, results already read) with a pointer to the backlog
- [ ] CHANGELOG.md: add `0.4.1 — <date>` with the change and both field reports as the reason
- [ ] bump the version to 0.4.1 in `package.json`, `plugin.yaml` and `PLUGIN_VERSION` (`index.mjs:88`); run `npm test`

## Technical Details
- Key: `loremax-wake:${workspace}:${agent}:${sessionKey || "service"}`. The agent is redundant for the host lookup but
  makes the key self-describing in the wakeups table.
- `onceId` values: `job:<row id>` (watcher terminal outcomes and the past-deadline save), `save:<row id>` (save failed,
  agent must act), `submit:<submitId>` (submission outcome off the tool call). The set lives as long as the process: it
  replaces the dedupe the per-row key gave while a wake was pending; after a restart the watcher wakes as it does today.
- Host behaviour this relies on (`enqueueWakeup`): same `(key, agent)` pending → `prompt = prev + "\n\n" + new` when
  they differ, `coalescedCount + 1`, `notBefore` reset to now. A wake already claimed is not merged: the next finish
  queues a new row with the same key behind the running session.
- The save-failed wake is not held back: it joins the conversation's pending wake if there is one, else goes alone.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- On a studio, start ~5 slow generations from one task with short waits, keep the agent busy, and check the wakeups
  table: one pending row with `coalesced_count` 4 and five lines in its prompt.

**External system updates**:
- Host work (event ids, group key, acks, atomic settle + wake, debounce): `docs/backlog/host-plugin-wake-events.md`.
- Batch wake: `docs/backlog/loremax-generate-batch-wake.md`, after the host work.
