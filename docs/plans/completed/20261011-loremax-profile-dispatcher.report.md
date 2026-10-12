# Report: LoreMax profile dispatcher and wait-budget fixes

**Plan:** `docs/plans/20261011-loremax-profile-dispatcher.md` · **Branch:** `loremax-profile-dispatcher` · **Base:** `main` · **Mode:** full · **Executor:** claude · **Task model:** claude:opus:high · **Review model:** claude:opus:high · **Started:** 2026-10-12T13:52:16Z · **Finished:** 2026-10-12T15:39:54Z

## Summary
This branch makes the LoreMax Bridex plugin 0.2.0. The work had two stages.

- **Stage 0 (REST mode fixes):**
  - **Wait budget:** the default wait is now 45 s, down from 180. Every `wait_s` is capped at 50 s, down from 1500, and the cap is enforced in code. The 50 s limit bounds the whole tool call, including fetch timeouts, Retry-After sleeps and inline saves.
  - **Detached submission:** a paid submission that LoreMax has not answered by the deadline now replies `submitting`. It then finishes in the background and wakes the agent.
  - **Restart safety:** a `submit:<uuid>` placeholder job records the pending submission. If the process restarts mid-submission, the watcher settles the row and wakes the agent once.
  - **Smaller fixes:** spend is recorded with `ref` = generation id, so it is idempotent. MCP calls now retry a 429. Text outputs are saved as `.md`. Audio, video and 3D outputs get real file extensions instead of `.bin`.
- **Stage 1 (profile mode):** a new optional `profile_url` setting switches the three existing tools to a curated LoreMax MCP profile. This adds:
  - a JSON-RPC client that handles batches;
  - a catalog cache;
  - profile versions of `loremax_workflows` and `loremax_generate`;
  - workspace file uploads (`request_upload_url → PUT → finalize_upload`), deduplicated by sha256 and cached;
  - mapping of LoreMax error codes to `rejected` / `failed` replies;
  - a profile-aware health check and balance tile.
- **No REST fallback:** an invalid `profile_url` is a config error. The plugin never falls back to the full organization catalog.
- **Run shape:**
  - tasks: 11 iterations, 0 failed retries;
  - internal review: 2 loop iterations, ended by `review_done`;
  - post-review: 3 iterations;
  - external review: Codex, 2 iterations.
- **Phase durations:**

| phase | duration_ms | ≈ |
|---|---:|---|
| evaluation | 101854 | 1 m 42 s |
| external review | 264115 | 4 m 24 s |
| internal review | 3415151 | 56 m 55 s |
| other | 0 | 0 |
| tasks | 2676331 | 44 m 36 s |

- **Finalize:** did not run, so there was no base sync with origin/main. Local `main` is one commit ahead of `origin/main`: that commit (`c05a7cf`) only saves the plan file. The diff is therefore taken against local `main`.

## Change scope
19 files changed: 4914 additions, 349 deletions.

- **Code:** `index.mjs` (+1662 lines changed).
- **Config / packaging:**
  - `plugin.yaml`: version 0.2.0, `default_wait_s` default 45 / max 50, new `profile_url` key, updated descriptions.
  - `package.json`: version 0.2.0.
- **Docs:**
  - `README.md`: profile mode, tool tables, upload limits, error codes, `submitting`, `.md` text outputs.
  - `CHANGELOG.md`: 0.2.0 entry with upgrade notes.
  - `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md`: updated.
  - The plan file: progress marks and ➕ items.
- **Tests:**
  - New: `test/catalog.test.mjs`, `test/upload.test.mjs`, `test/health.test.mjs`, `test/fixtures/profile-tools-list.json`.
  - Modified: `acceptance`, `config`, `generate`, `helpers`, `http`, `result-watcher`, `save`, `workflows`.
- **Commits (16):**
  - Eleven `feat:` commits implement Tasks 1–11; Task 10 also bounds inline saves by the 50 s deadline:
    - `8368330`, `e8642ec`, `d4e93fe`, `d3515ed`, `daa3141`, `136b0ba`, `296680a`, `c9e3fca`, `1e7fafb`, `f807810`, `1599348`.
  - Five `fix:` commits address review findings:
    - `748a759`, `849df6d`, `2399d15`, `9381177`: code review findings;
    - `b9d14d8`: Codex findings.

## Evidence
The run's validation phase recorded no commands. The only before/after evidence in the supplied facts comes from the external-review evaluator's report on the Codex findings:

- **Text save failure** (`test/save.test.mjs`):
  - *Before:* a blocked task folder made `saveOutputs` log a warning. `finish` then reported `completed` with no artifacts and settled the job, so the paid text was lost.
  - *After:* `finish` throws, the spend is recorded once and the job stays `running`. Once the folder is freed, a second `finish` saves the `.md` and settles the job.
- **Same-size file change during upload** (`test/upload.test.mjs`):
  - *Before:* a file rewritten with same-size content between hashing and PUT was uploaded, and its URL was cached under the original hash.
  - *After:* the upload is refused ("nothing was charged"), no PUT is sent and the cache stays empty.
- The evaluator reported that each new test fails against the old code, that the suite passes (219 tests, up from 92 at plan time), and that `node --check index.mjs` is clean.

This run recorded no independent test execution.

## Risk
**medium**

- **Public API (tool surface):**
  - The three tool names stay the same, but replies change. `loremax_generate` can now return `status: "submitting"` and `in_progress` ("being saved"), and profile mode returns `rejected` / `failed` JSON.
  - Agent prompts that do not treat `submitting` as "end the turn" could call the paid tool again; the changelog warns about this.
  - In profile mode the `loremax_generate` schema is `{tool, arguments, …}` instead of the REST shape.
- **Configuration:**
  - The `default_wait_s` default drops from 180 to 45 and the maximum from 1500 to 50. Existing values above 50 are silently capped.
  - `profile_url` is optional, and empty keeps REST mode.
- **Data schemas:**
  - Job rows gain `submit:<uuid>` placeholders, and profile job params gain a new shape (`mode: 'profile'`, `tool`, `arguments`, `references`, `identity`, `profile`).
  - Usage records gain `ref`.
  - No database schema changes.
- **Concurrency (the main risk):**
  - Detached submissions, background saves raced against the deadline, `inFlight` ownership shared by the handler, the watcher and `loremax_result`, and a process-wide upload cache.
  - Double-finish and double-wake paths were reviewed and tested, but only against fakes.
- **Migrations:** none in this repo.
- **Live verification:** profile mode depends on LoreMax rollout steps that have not been done yet (migration 078 on prod D1, the Pages deploy). It has not been checked against a live LoreMax.

## Merge danger
**Door:** two-way
A plain revert restores 0.1.0. The one thing left behind is that `submit:` job rows written by 0.2.0 would be handled by the 0.1.0 watcher, which does not know them. Nothing is published until 0.2.0 is pushed to the registry.

**Blast radius:** plugin
Limited to agents in Bridex instances that use the loremax plugin. Paid generations are the sensitive path: a mishandled `submitting` reply could lead to a duplicate charge.

## Migrations and operational steps
- **Config:** lower any `default_wait_s` above 50 in `bridex.yaml`; values above 50 are capped at runtime anyway.
- **Profile mode (optional):** set `profile_url` to a profile URL or a bare publicId from LoreMax Organization → MCP. Before that, LoreMax needs:
  - migration 078 on prod D1;
  - the Pages deploy;
  - smoke checks;
  - a studio profile created.
- **Agent prompts / studio:**
  - handle `status: "submitting"` as "do not call again";
  - in profile mode, update `studio/art-guide.md` to name profile tools.
- **Release:** publish 0.2.0 to the Bridex plugin catalog/registry.
- **Separate Bridex host change (not required for this merge):**
  - `tool_timeout_sec` in `cliMcpConfig.ts`;
  - a `callTool` timeout in `mcpClient.ts`.
- **Manual verification:** the scenarios listed under Post-Completion in the plan.

## Plan deviation
All Tasks 1–11 are checked off. Nothing was blocked or skipped. Added items (➕):

1. **Task 3:** until Tasks 6 and 8 landed, the profile-mode `loremax_workflows` / `loremax_generate` were registered as placeholders that threw "not available in this build yet". Tasks 6 and 8 replaced them.
2. **Task 4:** `rpc` returns one message for a single request and a `Map` by id for a batch. `toolResult` and `nextId` are exposed, and `-32601` sets `charged: false`.
3. **Task 5:** the catalog API:
   - concurrent `get` calls share one `tools/list`;
   - `refreshAfter(err)` marks the cache stale for the refresh codes;
   - `nextCursor` pages are followed;
   - a generation tool without a string revision is skipped with a warning.
4. **Task 5:** the fixture was assembled from the LoreMax doc examples plus `workflowToolContract.ts` at 8b4e6b43. Its `_source` key says which parts were made up.
5. **Task 6:**
   - the list hint and "no such tool" are plain errors/replies, as in REST mode;
   - over the reply cap, the description is shortened to 300 chars and `how_to_call` to one line;
   - a grown cap is measured on the schema as indented in the reply.
6. **Task 7:** the uploader API:
   - process-wide cache (≤ 2000 entries);
   - a single path is accepted where a list is expected;
   - `minItems` / `maxItems` are checked;
   - non-https URL schemes are refused;
   - failures carry `charged: false` and `deadline: true`;
   - the rule for when a finalize chunk counts as lost is defined.
7. **Task 8:** outcomes without a generation are returned as JSON (`rejected` / `failed`) instead of thrown. `toolError` keeps a lost reply from being taken for a failed run.
8. **Task 8:** the 15 s reserve on older cores is measured against the 50 s hard deadline, not `wait_s`. A detached unit's catalog lookup and uploads get no deadline.
9. **Task 8:**
   - profile job params keep `profile` (the publicId);
   - the REST and profile handlers share `raceBudget` / `landed` / `settleLate`;
   - one rule, `unanswered`, decides "outcome unknown" for both paid calls.
10. **Task 9:**
    - the health check force-rereads the catalog;
    - a profile with no generation tools fails the check;
    - the stat tile returns `[]` for an invalid URL;
    - tests are in the new `test/health.test.mjs`.
11. **Task 10 (found in review):** inline saves were not bounded by the 50 s deadline. They are now raced against it and moved to the background with a single wake. REST `loremax_workflows` also respects the deadline.
12. **Task 11:**
    - `package.json` is bumped to 0.2.0;
    - the README notes that a disabled profile's in-flight jobs still finish through REST polling;
    - the backlog entry points at `raceBudget`, the `submit:` placeholder and the orphan handling.

**Blocked:** none. **Skipped:** none.

## Backlog
There were no backlog entries. `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md` was updated as Task 11 planned; no new entries were filed.

## External review
### codex:gpt-6-astra:high
- label: codex
- iterations: 2
- duration_ms: 365952
- ended by: done
- had findings: true

**Iteration 1** (truncated: false):
- [P2] A text save failure settled the generation as successful (`index.mjs:730`) -> fixed: `saveOutputs` now returns `textError`, and `finish` records the spend and throws before settling, so the job stays running and is retried. Covered by a regression test in `test/save.test.mjs`, documented in the README, committed in `b9d14d8`.
- [P2] A same-size file change corrupted the upload cache (`index.mjs:903`) -> fixed: `stage()` checks the sha256 of the buffer it is about to PUT against the cache key and refuses a mismatch with "nothing was charged". Covered by a regression test in `test/upload.test.mjs`, committed in `b9d14d8`.

**Iteration 2** (truncated: false):
- No issues found. Both earlier fixes were confirmed.

## Validation
- Commands: none
- Timings: duration_ms 0, runs 0

The finalize phase did not run.