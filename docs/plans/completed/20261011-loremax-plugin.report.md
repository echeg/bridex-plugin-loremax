# Report: LoreMax catalog plugin — workflows, generation, provenance

**Plan:** `docs/plans/20261011-loremax-plugin.md` · **Branch:** `loremax-plugin` · **Base:** `main` · **Mode:** full · **Executor:** claude · **Task model:** claude:opus:high · **Review model:** claude:opus:high · **Started:** 2026-10-11T08:17:29Z · **Finished:** 2026-10-11T09:30:48Z

## Summary
This branch adds `loremax`, a Bridex catalog plugin of kind `integration`. It lets agents make images and video through the organization's own LoreMax workflows. The plugin is a manifest (`plugin.yaml`) and a single entry file (`index.mjs`), and it has no dependencies. It provides:

- **Three agent tools:**
  - `loremax_workflows` (free): lists the workflows, or shows one workflow's input fields, usage hint and token price through LoreMax's MCP endpoint.
  - `loremax_generate` (paid): runs a workflow. Inputs are passed through unchanged, and up to 20 workspace references are sent as multipart files.
  - `loremax_result` (free): checks a generation that took longer than the wait. It only answers the workspace that started the generation.
- **Output handling:** downloads are capped and streamed. Outputs are saved into a jailed task-artifact path with a `generation` provenance block (`provider`, `workflow`, `params.image_urls`, `externalId`). Token spend is recorded under kind `loremax`, with an optional `usd_per_token` conversion.
- **Reliability:** a watcher over `ctx.jobs.pending()` survives a reboot, wakes the agent, and gives up after 6 h. A 402 raises an out-of-funds card, and a 429 is retried once after `Retry-After`.
- **Monitoring:** a health check reports the key and the balance, and a dashboard tile shows the balance.
- **Older cores:** the plugin still loads on cores without `ctx.jobs`, `ctx.wakeAgent`, `ctx.billing` or `ctx.registerStat`.
- **Docs and tests:** a README, a 0.1.0 CHANGELOG, and a `node --test` suite in eight test files.

Phase durations (ms):

| phase | duration_ms |
|---|---:|
| evaluation | 199253 |
| external review | 203305 |
| internal review | 3230415 |
| other | 0 |
| tasks | 765784 |

The 7 task iterations had 0 failed retries. Internal review ran 3 loop iterations and ended by `review_done`. Post-review ran 5 iterations. Finalize did not run, so there was no base sync; `main` and `origin/main` point to the same commit (`243c70b`).

## Change scope
- **15 files changed, +2662 / −37.**
- **Added (12):**
  - Plugin files: `plugin.yaml`, `index.mjs` (772 lines), `package.json`, `CHANGELOG.md`
  - Backlog entry: `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md`
  - Tests: `test/helpers.mjs`, `test/acceptance.test.mjs`, `test/config.test.mjs`, `test/generate.test.mjs`, `test/http.test.mjs`, `test/result-watcher.test.mjs`, `test/save.test.mjs`, `test/workflows.test.mjs`
- **Modified (3):**
  - `README.md`: the one-line stub became the full plugin documentation.
  - `docs/plans/20261011-loremax-plugin.md`: checkboxes ticked, ➕ notes and the ⚠️ correction added.
- **16 commits:**
  - 6 feature commits: `082133b` manifest/config/client, `cbc1408` workflows tool, `80ee4ec` output saving, `a788202` generate, `d11cec5` result/watcher/check/tile, `363935b` acceptance tests
  - 1 docs commit: `0426a5a` README/CHANGELOG
  - 7 `fix: address code review findings` commits: `4cfd171`, `c0354e7`, `4b9e866`, `ec9f31f`, `db6cd42`, `efb6562`, `2eafa45`
  - 1 commit with the Codex review fixes: `4797e77`
  - 1 backlog commit: `a093d82`

## Evidence
`none` from the run's own validation step: it recorded 0 commands and 0 runs.

The only test results in the facts were reported by the external-review evaluator, not run by the validation step:
- After fixing the Codex findings, the evaluator reported 84 of 84 tests passing: 78 existing and 6 new regression tests. `node --check index.mjs` passed.
- One new test failed at first and exposed a real gap. Removing the temp file after a failed save could itself throw `ENOTDIR`, so that removal was made best-effort.
- The evaluator found that the test double's `jobs.find()` returned `workspace`, but the real host's `find()` does not. That is why the existing "other workspace refused" test passed while failed jobs from another workspace leaked. The new test uses the host's real row shape (`id`, `status`, `result`, `error`).

## Risk
**medium**

- **Public APIs:** the change adds three agent-facing tool names and their schemas (`loremax_workflows`, `loremax_generate`, `loremax_result`) and exports `createClient` and `createOutputs` as test seams. Nothing existing changes, because this is a new plugin in its own repository.
- **Data schemas:** there is no database schema. The plugin writes `generation` provenance through `ctx.artifacts.annotate` in the shape the studio's `ProvenanceCard` already reads (`params.image_urls`). The job label encodes token spend (`<note> · <n> tk`) so it survives a restart.
- **Configuration:**
  - New `config_schema`: `api_key`, `base_url`, `default_wait_s` (10–1500, default 180) and `usd_per_token`.
  - Both `LOREMAX_API_KEY` and `LOREMAX_BASE_URL` are in `requires_env`, so the host won't start the plugin until both are set.
- **Concurrency:**
  - The tool's poll and the watcher can see the same generation. Generation ids a tool call is polling are skipped by the watcher, which prevents a double download or settle.
  - Because the watcher skips those ids, a CLI agent whose MCP tool timeout is shorter than `wait_s` may never be woken. This is the open backlog item.
  - On older cores the in-memory generation map is lost on restart.
- **Migrations:** none.
- **Why medium rather than low:** the plugin spends real organization tokens. Workspace isolation in `loremax_result` and the memory bound on downloads needed review fixes; both were P1/P2 Codex findings. It is not low-risk until it has run against a live LoreMax.

## Merge danger
**Door:** two-way
The plugin is new and not yet in the catalog registry (`bridex-plugins/index.yaml`), so nothing depends on it yet; a plain revert removes it.

**Blast radius:** plugin
It only affects Bridex instances that install `loremax` from the catalog and set both credentials. Bridex core and other plugins are unaffected.

## Migrations and operational steps
- Push the repository to GitHub (`nik-devs/bridex-plugin-loremax`).
- Add a `loremax` entry with the pinned commit to `bridex-plugins/index.yaml`, with `permissions: { network: true, llm: false }`.
- On each instance, set `LOREMAX_API_KEY` (an `lmx_prod_…` key) and `LOREMAX_BASE_URL` (for example `https://loremax.ai`) in Settings → Integrations. Both are required, even when LoreMax is at its default address.
- Two companion plans in other repositories:
  - Bridex (`studio` branch): `20261011-studio-loremax-generation`, which adds `loremax` to the studio's generation plugins, the wiki pages and the art-guide skill.
  - bridex-cp: `20261011-cp-studio-loremax-env`, which passes `STUDIO_LOREMAX_*` through as `LOREMAX_*`.
- Manual checks from the plan's Post-Completion section:
  - the plugin check reports the token balance;
  - a cheap `loremax_generate` with one `artifacts/…` reference produces the file, the Source card and the spend chart entry;
  - killing the server mid-wait still lets the watcher finish the generation and wake the agent.

## Plan deviation
All checkboxes in Tasks 1–7 are ticked.

**Added (5 ➕ notes, all kept in the plan):**
1. The client lives in an exported `createClient(ctx)`, which `activate` uses. `mcpCall` sends the Streamable HTTP `Accept` pair and also parses an SSE-framed reply. Errors carry `status` and `body`.
2. The path jail, `saveOutputs` and `finish` live in an exported `createOutputs(ctx, lmx, { downloadCap })`. `finish` returns the reply as an object. A declared `Content-Length` over the cap is skipped before the body is downloaded.
3. `activate(ctx, { pollMs, now })` takes a test-only second argument; the host passes only `ctx`. The `/check` call is `lmx.check(id)`, which turns LoreMax's HTTP 500 `failed` body into a normal reply so the watcher can reuse it.
4. `loremax_generate` and `loremax_result` share one `waitFor` poll. The watcher skips generations that a tool call is polling. `loremax_result` returns a settled failed job's error as `status: "failed"`. The watcher wakes the agent on the 6 h give-up too and treats check errors as transient. An empty balance makes the check `ok: false`. The tile carries `balance` and `low`.
5. The acceptance checks live in `test/acceptance.test.mjs`, and `plugin.yaml` was also parsed with Ruby's YAML.

**Blocked (1 ⚠️):** some LoreMax MCP facts in the plan's Decisions were wrong and were corrected during code review against the source (`McpProtocolHandler.ts:562-601`, `schemas/mcp.ts:366-368`, `execute.ts:567-603`, `check.ts:184-190`). Nothing was left blocked; the corrected behaviour was built:
- `get_workflow_details` takes `{visual_id}` and returns a flat object.
- A tool's text content is the data itself, and failures use `isError: true` instead of a `{success, …}` wrapper. This changes Task 1's `mcpCall` description.
- An execute that finishes right away returns outputs directly, and its `/check` answers 400, so the plugin saves those outputs without polling.
- Because `LOREMAX_BASE_URL` is in `requires_env`, the "empty = default" fallback only applies to `config.base_url`.

**Skipped:** none.

**Unrecorded deviations from the review loops:**
- On older cores, `loremax_result` now refuses unknown generation ids, including ones lost in a restart; the README says so.
- A file that fails to save locally stays on LoreMax's CDN, and its spend is still recorded.

## Backlog
- `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md`: **Long-waiting media tools can outlive a CLI agent's MCP tool timeout.** Severity major, found in internal review.
  - **Disposition:** filed to backlog and left open. The fix belongs in the Bridex host (`server/src/runtime/cliMcpConfig.ts`), not in this repository. It also affects the host's `media_video` and `fal_run`.
  - **Fix direction:** set `tool_timeout_sec` above 1500 s for Codex, or have the host tell plugins when the caller has gone so the watcher sends the wake.

## External review
### codex:gpt-6-astra:high
- label: codex
- iterations: 2
- duration_ms: 402540
- ended by: done
- had findings: true

**Iteration 1** (truncated: false). All five findings were fixed in `4797e77`:
- [P1] Workspace isolation disappears without `ctx.jobs` (`index.mjs:545`): on older cores `loremax_result` accepted any generation id -> fixed. In-memory jobs now record their workspace, and one owner check rejects unknown ids and ids from other workspaces before any LoreMax request.
- [P2] Failed jobs bypass workspace authorization (`index.mjs:560`) -> fixed. All three failure settles store `result: { workspace }`, and the owner check runs before the failed reply.
- [P2] Download size limit does not bound memory consumption (`index.mjs:272`) -> fixed. A new `readCapped()` reads the body in chunks and cancels the stream once the cap is passed.
- [P2] Local save errors lose paid synchronous results (`index.mjs:302`) -> fixed. Saving is handled per output. On failure the URL goes to `left_on_cdn`, spend is still recorded, and the job is settled. A failed annotate only logs a warning, and temp-file removal is best-effort.
- [P2] Watcher hides outputs left on the CDN (`index.mjs:647`) -> fixed. The wake message lists the CDN URLs. "LoreMax returned no files" only appears when there were really no outputs.

**Iteration 2** (truncated: false): NO ISSUES FOUND. Codex confirmed all five fixes; it checked syntax but did not rerun the tests. The evaluator ran the suite and reported 84/84 passing.

## Validation
- Commands: none
- duration_ms: 0
- runs: 0
- Finalize: not run