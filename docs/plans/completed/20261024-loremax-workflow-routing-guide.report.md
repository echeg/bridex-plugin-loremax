# Report: LoreMax plugin: a workflow routing guide, profile instructions and profile text editing

plan: /Users/echeg/Projects/bridex/bridex-plugin-loremax/.loopai/worktrees/loremax-workflow-routing-guide/docs/plans/20261024-loremax-workflow-routing-guide.md · branch: loremax-workflow-routing-guide · base: main · mode: full · executor: claude · task model: claude:opus:high · review model: claude:opus:xhigh · started: 2026-10-24T10:10:55Z · finished: 2026-10-24T11:34:20Z

## Summary
The plugin moves to version 0.3.0. The code is in place for every part of the plan, but the guide's content is not filled yet:

- **Routing guide (`guide.mjs`).** The plugin now ships a guide. It is always matched against the live catalog. Helpers `guideKey`, `guideEntry` and `recommendedFrom` are in `index.mjs`, and tests can pass their own guide through `activate(ctx, { guide })`.
- **REST `loremax_workflows`.** The list returns `recommended` and `rules` ahead of the workflows. A workflow's details include `guide`. The tool description now tells agents to start from `recommended`.
- **Profile mode.** The plugin sends a separate `initialize` request to read the profile's `instructions`, only when the agent asks for the list. The result is cached for 10 minutes, LoreMax's standard lines are dropped, and a failed request gives `null`.
- **Profile list and details.** The list adds `instructions`, `recommended` by tool name, `rules` and a per-tool `use_for`. A list over the reply cap is shortened without cutting any row. Details add `guide`, which is the first thing dropped when the reply is over the cap.
- **`loremax_profile_edit`.** A new tool, registered only in profile mode with the new `allow_profile_edit` setting (default `false`). It edits texts only, previews first and then applies. It re-reads the profile before saving, refuses unsafe edits, and marks the caches stale after a save.
- **Docs and version.** README, CHANGELOG, the `index.mjs` header comment and the version in all three places were updated.

**Main limitation:** Task 7 was blocked because the catalog export did not exist. The shipped guide has only the 9 model-agnostic `rules`; `workflows` is `{}` and `routes` is `[]`. In real replies, `recommended`, `use_for` and `guide` will never appear until a follow-up release fills the guide. This is tracked in the backlog.

Run profile:
- 9 task iterations, 0 failed retries.
- Internal review: 2 loop iterations, ended by `review_done`.
- Post-review: 2 iterations.
- External review (codex): 3 iterations, ended `done`. Its 3 findings were all fixed.

| phase | duration_ms | ≈ |
|---|---:|---|
| evaluation | 457395 | 7m 37s |
| external review | 313411 | 5m 13s |
| internal review | 3109133 | 51m 49s |
| other | 0 | 0s |
| tasks | 1125456 | 18m 45s |

The phases add up to 5005395 ms (≈ 83m 25s), which matches the time from start to finish. That timing covers work through finalize, before this report and archival.

Finalize did not run, so there was no base sync. The diff is against `main`. Local `main` (cc34dd9) is `origin/main` (fb1be0b) plus the commit that saved this plan, and `origin/main` is an ancestor of HEAD.

## Change scope
16 files changed: **+2182 / −131**.

- **New files (5):**
  - `guide.mjs`: the guide module, rules only for now.
  - `.gitignore`: ignores `docs/catalog/`.
  - `docs/backlog/loremax-guide-fill-from-catalog-export.md`
  - `test/guide.test.mjs`, `test/instructions.test.mjs`, `test/profile-edit.test.mjs`
- **Runtime code:**
  - `index.mjs`: about 580 lines changed.
  - `plugin.yaml`: version 0.3.0 and the `allow_profile_edit` setting.
  - `package.json`: version 0.3.0.
- **Docs:** `README.md`, `CHANGELOG.md` (0.3.0 entry), and the plan file (progress notes and ➕/⚠️ items).
- **Updated tests:** `test/workflows.test.mjs`, `test/catalog.test.mjs`, `test/generate.test.mjs`, `test/acceptance.test.mjs`. The acceptance test now expects `allow_profile_edit` in the config schema with default `false`.

13 commits:
- **Implementation (8 `feat`):**
  - 7aedb93: guide module and helpers
  - dc78f99: REST list and details
  - e31a82e: lazy instructions
  - b71d9fe: profile list and details
  - fdc0888: the setting and the management-id lookup
  - e8c609a: edit preview and apply
  - 561e3d2: Task 7 marked blocked
  - 3b881e3: acceptance checks and the "no `initialize`" regression test
- **Docs and release (1 `feat`):** 0304012
- **Review fixes (4 `fix`):** e370ddf, 55a1671 and c11b0f5 from the internal review; 48930a3 from the codex review.

## Evidence
The validation facts record no commands and no runs (0 runs, 0 ms). The evidence below comes from the review reports and from notes in the plan diff, as the agents reported them. These are not test runs recorded by the harness.

- **Codex finding 1: cached management ID used after an address change.**
  - Test: `profile edit: a cached id serves only the server and key it was found with` in `test/profile-edit.test.mjs`.
  - The evaluator reported it **fails against the pre-fix HEAD and passes with the fix**.
  - Before the fix: preview on server a, switch to server b, then apply returned `applied: true` against b's `/mcp-servers/17`. After the fix the apply is refused and nothing is sent to b.
- **Codex finding 2: a plugin update keeps serving the old guide.**
  - Test: `an update loaded as index.mjs?v=<commit> serves that release's guide, not the first one's` in `test/guide.test.mjs`.
  - It imports the entry as `?v=aaa111` and then `?v=bbb222`, rewriting `guide.mjs` in between.
  - Reported to **fail against the pre-fix HEAD and pass with the fix**.
- **Codex finding 3: the address or key changing while an edit is running.**
  - Test: `profile edit: the address or key changing while a request is out stops the edit before its next request`.
  - With the guard turned off it fails with `Missing expected rejection`, which is the overwrite codex reported. With the guard on it passes.
- **Suite counts reported along the way:**

  | when | tests | pass | fail | skipped |
  |---|---:|---:|---:|---:|
  | Task 7 (plan note) | — | 318 | — | 1 |
  | Task 8 (plan note) | 320 | 319 | — | 1 |
  | After codex iteration 1 fixes | — | 331 | 0 | 1 |
  | Iteration 2, and before committing 48930a3 | 333 | 332 | 0 | 1 |

  The one skip is the check of the guide against the catalog export, which skips by design while there is no export.
- **Not covered:** the facts give no suite count after the last internal-review commit c11b0f5, which added the over-cap profile-list test. There is also no before/after evidence that the guide improves routing, because its workflows and routes are empty.

## Risk
**medium**

- **Public APIs.** Tool replies change for every agent using loremax, in both modes:
  - New fields are added: `recommended`, `rules`, `guide`, `instructions`, `use_for`. The REST tool description changed. Existing fields stay.
  - The profile list is now built as a string that is shortened step by step instead of being cut at the cap, so its output path is new code.
  - A fourth tool, `loremax_profile_edit`, appears only when someone opts in.
  - Generation, uploads, results, the watcher and the health check are meant to send the same requests as before. A profile-mode regression test in `test/generate.test.mjs` covers those paths.
- **Data schemas.** Nothing is stored in this repo. The new edit tool, however, writes to an outside system: LoreMax's `PUT /api/v2/mcp-servers/<id>` replaces the whole profile, and the change affects **every client of the profile**, not only Bridex.
  - Safeguards: preview comes first, the profile is re-read before saving, bindings, tool names and `is_active` are never changed, and the tool refuses `[redacted]` text, texts over 2000 characters, unknown tool names and incompatible workflows.
  - Known residual risk: LoreMax has no ETag, so a manager's edit landing between the re-read and the save can be lost. The README documents this.
- **Configuration.** One new setting, `allow_profile_edit`, a boolean that defaults to `false` and counts only a literal `true`.
  - The guide is now loaded with a top-level `await import(...)` that carries the entry's `?v=` query. Every activation depends on that import, so a broken `guide.mjs` would stop the plugin from loading.
- **Concurrency.**
  - New shared in-flight promises for the instructions cache.
  - A version counter so a catalog read already running when `markStale()` is called does not fill the cache.
  - The management-id cache is keyed by base URL, profile and a hash of the key.
  - A synchronous scope check before each edit request stops an edit if the address or key changes while it is running.
  - All of these have tests.
- **Migrations.** None.

## Merge danger
**Door:** two-way
A plain revert brings back 0.2.1: the reply fields and the setting are additions, the setting defaults to off, and nothing is stored in this repo. The one exception is any LoreMax profile text an agent saves with the edit tool after someone enables it; a revert would not undo that.

**Blast radius:** plugin
Every agent's `loremax_workflows` reply changes in both modes. Only instances in profile mode with `allow_profile_edit: true` can write to LoreMax, and those writes reach every client of that profile.

## Migrations and operational steps
none

Optional steps, not needed for this merge:
- Set `allow_profile_edit: true` only on instances where agents should be allowed to rewrite profile texts.
- Do the manual checks listed in the plan's Post-Completion section against a real LoreMax, in profile mode and in REST mode.
- Produce the catalog export to unblock the backlog item. That will be a later release.

## Plan deviation
Tasks 1–6, 8 and 9 were done as planned. Task 7 was blocked.

**Added (supplied):**
- ➕ `PLUGIN_VERSION` constant in `index.mjs` for `clientInfo`. A test keeps it equal to `package.json`, and later also to `plugin.yaml`. It was bumped to 0.3.0 in Task 9.
- ➕ `createProfileInstructions` is wired into `activate`; Task 3 had only defined it. The list reads the catalog and the instructions in parallel.
- ➕ `recommendedFrom`'s query also matches a profile item's tool name, like the profile list's own filter.
- ➕ A full profile's list over `REPLY_CAP` is shortened without cutting any row:
  - First the guide gives way, in this order: `rules` and `why`/`use_for`, then `recommended`.
  - Then descriptions shrink to 100 characters.
  - Every tool row, the whole `instructions` and the hint stay. The hint says the list was shortened.
  - Added in internal-review commit c11b0f5.
- ➕ Until Task 6, the handler of `loremax_profile_edit` only resolved the management id (`{ profile_id }`, read-only). This was a temporary step that Task 6 replaced.
- ➕ `createProfileCatalog` gains `markStale()`; a save calls it.
- ➕ Three edit-tool details:
  - A cleared text is sent as `""`, and LoreMax's `null` counts as empty.
  - An apply whose fresh `GET` already lists an incompatible workflow is refused without a `PUT`.
  - A save that gets no reply says it may or may not have been stored, and still marks the caches stale.

**Also noted in the plan (➕, not in the supplied list):**
- Task 8: a regression test in `test/generate.test.mjs` runs all five paths in profile mode with the edit setting on.
- Task 9: the version test also checks `plugin.yaml`.

**Beyond the plan, from reviews:**
- Internal review:
  - A new text containing `[redacted]` is refused too. The plan only covered unchanged text.
  - A `warning` names unchanged texts with a URL whose `#fragment` and `user:pass@` LoreMax drops. The plan's verified facts were updated to match.
  - A catalog read already running when the cache is marked stale is not cached.
  - Better handling of a 400 without JSON, and of a 204 or no reply on save.
- Codex review:
  - The management-id cache is tied to one server, profile and key.
  - The edit stops if the address or key changes while a request is running.
  - The guide import carries the `?v=` query.
- New test files the plan did not list: `test/instructions.test.mjs`, plus changes in `test/catalog.test.mjs`, `test/generate.test.mjs` and `test/acceptance.test.mjs`.

**Blocked:**
- ⚠️ Task 7 (fill the guide from the catalog export): `LOREMAX_CATALOG_EXPORT` was unset, and there was no `docs/catalog/loremax-workflows.json` in the worktree or the main checkout.
  - Its checkboxes were ticked with ⚠️ notes so the loop would not retry it.
  - `GUIDE.workflows` and `GUIDE.routes` ship empty; nothing was made up.
  - The rule against organization-specific content holds.
  - The check against the export is skipped.
  - It is tracked in the backlog.

**Skipped:** none.

## Backlog
- `docs/backlog/loremax-guide-fill-from-catalog-export.md`: "The routing guide ships without workflows or routes".
  - Severity: major. Found in the internal review.
  - **Disposition: filed, still open.** It is the follow-up for blocked Task 7.
  - To close it: produce the export, fill `GUIDE.workflows` and `GUIDE.routes` with no organization-specific content, run `npm test` so the export check stops skipping, and release with a CHANGELOG note that `recommended` now ships.

## External review
### codex:gpt-6-astra:xhigh
- label: codex
- iterations: 3
- duration_ms: 770778
- ended by: done
- had findings: true

Iteration 1:
- [P2] A cached management ID can target the wrong profile after an address change (`index.mjs:647`) -> fixed.
  - The id cache now remembers the base URL, the profile and a sha256 of the key, and looks the id up again when any of them changes.
  - The suggested check of `public_id` on the fetched profile was not added: the plan's verified `GET /api/v2/mcp-servers/<id>` response has no `public_id`, so the check would never fire.
- [P2] Plugin updates keep the previously loaded guide (`index.mjs:4`) -> fixed. `guide.mjs` is now loaded with a top-level dynamic import that carries the entry's `?v=<commit>` query.

Iteration 2:
- [P2] An edit already running can still target another server's profile (`index.mjs:664`) -> fixed.
  - A `profileScope` value is read in the same tick as the id lookup.
  - Every later request (the profile `GET`, the preview `PUT`, the apply `PUT`) goes through a wrapper that refuses to send if the scope changed. It saves nothing and does not call `onSaved`.

Iteration 3:
- NO ISSUES FOUND.

The fixes were committed as 48930a3. Nothing from this reviewer was filed to the backlog.

## Validation
- Commands: none
- Timings: duration_ms 0, runs 0

The harness recorded no validation runs. The agent-reported `npm test` counts are under Evidence; the project has no linter configured.