# Report: LoreMax plugin: no double charge, no key on redirects, a quiet watcher

Plan `docs/plans/20261015-loremax-review-fixes-1.md` · branch `loremax-review-fixes-1` · base `main` · mode `full` · executor `claude` · task model `claude:opus:high` · review model `claude:opus:high` · started `2026-10-15T05:42:11Z` · finished `2026-10-15T06:28:06Z`

## Summary
This branch fixes the three highest-ranked findings from the nik-devs/bridex-plugins#1 review of the LoreMax plugin and ships them as version 0.2.1.

1. **No double charge.** A `loremax_generate` call that matches a submission still in flight is refused before any request is sent. The reply is `status: "submitting"` with `duplicate_of: "submit:<uuid>"` and a "do NOT call again" hint. The duplicate key is a sha256 over:
   - mode, workflow or tool, and the arguments as canonical JSON
   - the reference file hashes, in order
   - the destination: base URL, profile path and a hash of the API key
   - the caller: workspace, agent, session and task

   The key is held in a process-wide map from `trackSubmit` until `settleSubmit`. On cores without `ctx.jobs` it is held until the submission settles.
2. **The key never follows a redirect.** `send()` now uses `redirect: "error"`. A 3xx becomes a status-0 error ("redirected — refused, the key must not leave <host>"). On a paid request it is treated as "may have been charged".
   - `base_url`, `LOREMAX_BASE_URL` and `profile_url` accept `https://` only.
   - An `http://` value is a config error, raised through `needsConfig` at activation and reported separately by the health check.
3. **A quiet watcher.** Each pending generation is checked on a schedule that slows with its age: every 15 s for the first 2 min, every 60 s up to 30 min, then every 5 min. The 6 h give-up is unchanged.
   - The schedule counts from the start of each pass, and a failed `/check` keeps it.
   - Only one watcher runs per process. Its handle lives in `globalThis[Symbol.for("bridex.loremax.watcher")]`. A new activation clears the previous interval, stops any pass already running at its next row, and takes over its `generations` map.

Phase durations: tasks 830234 ms (~13m50s), internal review 1492230 ms (~24m52s), external review 265296 ms (~4m25s), evaluation 167328 ms (~2m47s), other 0 ms. These add up to the 45m55s between start and finish. There were 5 task iterations with 0 failed retries. Internal review ran once and ended by `review_done`, and post-review ran 3 iterations.

Finalize was not run, so there was no base sync with origin/main.

## Change scope
- **Files (12, all modified):**
  - Code and metadata: `index.mjs`, `package.json`, `plugin.yaml`
  - Docs: `README.md`, `CHANGELOG.md`, `docs/plans/20261015-loremax-review-fixes-1.md`
  - Tests: `test/config.test.mjs`, `test/generate.test.mjs`, `test/health.test.mjs`, `test/helpers.mjs`, `test/http.test.mjs`, `test/result-watcher.test.mjs`
- **Diff:** +1007 / −75 lines. Most of the growth is tests: `test/generate.test.mjs` +374, `test/result-watcher.test.mjs` +223. `index.mjs` changed by about +194/−19.
- **Commits (9):**
  - `de1ffef` feat: API requests refuse redirects, base_url and profile_url are https only
  - `b79609b` feat: an identical loremax_generate in flight is refused, not charged twice
  - `11af6d7` feat: one LoreMax watcher per process, polling slows down with a generation's age
  - `7a646ec` feat: verify acceptance criteria for the review fixes
  - `44950cc` feat: document https-only URLs, the duplicate-submission reply and the watcher cadence (0.2.1)
  - `b430f5d` fix: address code review findings
  - `96fdf93` fix: address codex review findings
  - `a56ed8c` fix: address code review findings
  - `a87f236` fix: address code review findings

## Evidence
The run's validation record has no commands and no runs (0 runs, 0 ms). No before/after test run was captured by the pipeline.

The only before/after proof in the facts comes from the external-review evaluator's narrative. Its own test runs were not recorded as validation:
- **Duplicate key ignored the destination:** the new test in `test/generate.test.mjs` re-activates the plugin with a different `base_url` or API key while a submission is held. The evaluator reported it timed out without the fix, because the new server was never contacted, and passed with it.
- **Replaced watcher kept checking:** the new test in `test/result-watcher.test.mjs` reported `['501', '502', '502']` without the fix, which is Codex's reproduction, and `['501', '502']` with it.
- The evaluator reported "All 251 tests pass" after round 1 and "All 252 tests pass" before committing `96fdf93`.

The diff also adds tests for the original three findings: redirect handling (`test/http.test.mjs`, `test/health.test.mjs`), https-only config (`test/config.test.mjs`), duplicate refusal (`test/generate.test.mjs`) and cadence and handover (`test/result-watcher.test.mjs`). The pipeline recorded no run of them.

## Risk
**medium**
- **Public API (tool replies):** tool names and argument shapes are unchanged. `loremax_generate` can now return a new reply shape, `{ status: "submitting", duplicate_of, workflow|tool, hint }`. An agent that does not recognise it gets no result for that call. The hint tells it the result will come through a wake or through the first call.
- **Configuration:** this is a deliberate breaking change. An `http://` `base_url`, `LOREMAX_BASE_URL` or `profile_url` used to be accepted and is now refused at activation and on every call. The CHANGELOG has an upgrade note. A server that answers API calls with a redirect, which used to be followed, now fails.
- **Concurrency:** this is the main risk area.
  - New process-wide state on `globalThis`: the `submitting` map and the watcher slot.
  - A per-activation `active` flag, plus the hand-over of `generations` between activations.
  - A late `onShutdown` from an older instance has to leave the current watcher alone. The code checks that, and external review and its follow-up tests found and fixed two races.
  - The duplicate key is freed only when it still belongs to the same submission id, which avoids freeing a newer holder's key.
- **Data schemas:** no persisted schema change. Job-row params gain nothing persistent. The `key` lives only in memory.
- **Migrations:** none.

## Merge danger
**Door:** two-way
A plain revert restores 0.2.0 behaviour: all new state is in memory and nothing is persisted. 0.2.1 is not yet pinned in the catalog (that is a post-completion step).

**Blast radius:** plugin
The changes are limited to the LoreMax plugin process: its generate tools, health check and result watcher. Every agent that uses LoreMax on an instance is affected.

## Migrations and operational steps
- Before upgrading, any instance whose `base_url`, `LOREMAX_BASE_URL` or `profile_url` starts with `http://` must change it to `https://`. Otherwise the plugin card raises a config error and every call is refused.
- Post-completion (from the plan): pin the new commit as `loremax 0.2.1` in `echeg/bridex-plugins` `index.yaml` and push. Instances then update from the catalog (Settings → Plugins).

## Plan deviation
All 5 tasks and Iteration 1 are checked off.
- **Added:**
  - ➕ Health check: a refused redirect (status 0) or a config error (an `http://` base_url) gets its own message instead of "LoreMax refused the key (0)". Implemented in the health handler, with `mockFetch` emulating Node's 3xx behaviour.
  - ➕ Profile mode hashes the reference files before `trackSubmit`, because the upload step runs after it. Every string argument that resolves to a workspace file counts, and a late failure after `submitting` frees the key. Implemented as `argFileHashes`.
  - ➕ The watcher schedule counts from the pass's start time, not from each `/check`. Implemented as `passAt`, with half a tick of slack.
  - ➕ `package.json` is also set to `0.2.1` to match `plugin.yaml`. Done.
- **Blocked:**
  - ⚠️ `nextCheck` is per activation, not process-wide as the plan's Task 3 specified. A process-wide map keyed by generation id leaked schedules between tests with the same ids. Only one watcher runs, and a fresh activation checking every pending job once is harmless. Entries are pruned each pass for rows that are no longer pending. This is an accepted design deviation, not unfinished work.
- **Skipped:** none.
- **Beyond the original plan, from reviews:**
  - Iteration 1: the caller and reference order are part of the duplicate key, oversized profile files are hashed by size:mtime, `generations` are handed over between activations, and an `http://` base_url raises `needsConfig` at activation.
  - External review: the destination (`target`) is part of the duplicate key, and the watcher gets a `stop()` function.
  - Post-review commits: `b430f5d`, `a56ed8c`, `a87f236`.
  - The plan's Technical Details were updated to match.

## Backlog
None. No backlog files were created. The plan's existing out-of-scope item (streaming downloads to disk) stays deferred, as the plan already recorded.

## External review
### codex:gpt-6-astra:high
- label: codex
- iterations: 2
- duration_ms: 432607
- ended by: done
- had findings: true

Iteration 1:
- [P2] Scope duplicate keys to the configured API and profile (`index.mjs:880`). After a settings change, a call to another server, organization or profile was refused as a duplicate. -> fixed: `submitKey` takes `target = { base, profile, auth: sha256(api key) }` via `submitTarget()`, and a regression test was added in `test/generate.test.mjs`.
- [P2] Stop active watcher passes during replacement (`index.mjs:2122`). `clearInterval` let an already-running `watchOnce` keep going, which caused duplicate `/check` calls. -> fixed: a per-activation `active` flag is checked before each row, the slot holds `{ interval, generations, stop }`, `prev.stop()` runs on replacement and `stop()` on shutdown, and a regression test was added in `test/result-watcher.test.mjs`.

Iteration 2: no issues found. Codex confirmed both fixes, and the evaluator committed them as `96fdf93`.

## Validation
- Commands: none
- Timings: duration_ms 0, runs 0