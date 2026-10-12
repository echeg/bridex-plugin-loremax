# LoreMax profile dispatcher and wait-budget fixes

## Overview
- Two stages in one plan. **Stage 0** fixes defects of the current REST-based plugin that exist today and must
  work against the currently deployed LoreMax. **Stage 1** adds a **profile mode**: when `profile_url` is
  configured, the three Bridex tools (`loremax_workflows`, `loremax_generate`, `loremax_result`) use a LoreMax
  organization MCP profile (`/api/mcp/s/<publicId>`) as catalog and execution channel. In that mode the agent sees
  only the 1–10 workflows a LoreMax manager curated, with exact typed argument schemas, file arguments described by
  `x-loremax-media`, and validation before debit.
- Stage 0 defects:
  - a tool call can outlive the 60 s MCP client timeout of Bridex agents, so the agent gets "timeout" for an
    already paid generation and is never woken;
  - spend can be recorded twice;
  - `mcpCall` does not retry 429;
  - Text workflows are charged and then reported as "no files";
  - audio and 3D outputs are saved as `.bin`.
- The tool surface stays three stable tools, so agent prompts and the studio wiring do not change. The
  watcher/artifacts/provenance/usage/wake machinery is reused. Without `profile_url` the plugin works as 0.1.0
  (REST mode) plus the Stage 0 fixes; REST mode also serves workflows a profile cannot hold (Scene/Reference
  Builder, Prompt Editor V2, 3D Camera).

## Decisions
- **Context**: LoreMax ships typed MCP profiles; the hardening plan
  (`fluxgenenerator/docs/plans/completed/20261011-mcp-profiles-hardening.md`) is merged into LoreMax `main`
  (2026-10-12, pushed) and its contract is documented in `fluxgenenerator/docs/mcp-workflow-profiles.md`. Stage 1
  targets that contract as it stands; the facts below were re-verified against it on 2026-10-12.
- **Chosen approach — dispatcher**:
  - keep three Bridex tools;
  - read the profile's `tools/list` as data and give its JSON Schema to the agent as text;
  - upload workspace files through `request_upload_url → PUT → finalize_upload`;
  - inject `schema_revision` and `on_behalf_of`;
  - call `tools/call`;
  - poll with REST `POST /api/v2/generations/:id/check`.
- **Rejected alternatives**:
  - mirroring each profile tool as its own Bridex tool: the host accepts only zod raw shapes (`PluginToolDef.schema`,
    studio `types.ts:77-78`); one unrepresentable type would break `tools/list` for every agent; tools cannot be
    unregistered; the tool set would be global to the instance;
  - connecting the profile as a raw remote MCP server in `bridex.yaml`: no artifacts, provenance, jobs, wake or
    out-of-funds card, and the full-scope key would land in the agent's argv/config.
- **Profiles per instance**: one `profile_url` per instance; per-workspace profiles can be added later without
  breaking the config.
- **Mode**: `profile_url` non-empty → profile mode only (one catalog for the agent). An invalid non-empty
  `profile_url` never falls back to REST mode: that would silently expose the whole organization catalog and lose
  the preflight guarantee. Empty → REST mode.
- **Price before launch**: not read in profile mode (LoreMax decided against a profile pricing tool; Bridex
  budgets are post-factum). The rule "ALWAYS read price before loremax_generate" applies only to REST mode.
  The authoritative `tokensCost` from the execute reply is recorded.
- **Wait budget** (user decision: lower to 45 s):
  - `default_wait_s` becomes 45 and every budget is capped at 50 s. The cap stays below the 60 s MCP SDK
    default request timeout that the Bridex llm adapter uses (studio `server/src/runtime/mcpClient.ts:154`,
    SDK `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`).
  - The budget is measured from tool start and covers everything the call does: catalog lookup, uploads,
    submission, polling, Retry-After sleeps and downloads.
  - The paid submission runs as a detached unit. Past the budget the tool replies `submitting`, finishes in the
    background and wakes the agent.
  - A placeholder job row makes that state restart-visible.
  - On cores without `ctx.jobs` / `ctx.wakeAgent` nothing is detached (0.1.0 blocking behavior).
  - Fixing the host timeouts (`cliMcpConfig.ts` `tool_timeout_sec`, the `callTool` timeout) stays a separate
    Bridex change.
- **Schema revision mismatch** (user decision): refresh the catalog cache and return the fresh schema to the agent
  with "not charged — check your arguments"; no automatic retry, because defaults, bounds or required fields may
  have changed.
- **Generation-tool detection**: a profile tool is a generation tool when its `inputSchema.properties` declares
  `schema_revision` and its name is not a known service tool; `_meta['loremax.ai/workflow']` is used for identity
  when present, never for classification.
- **Verified facts**:
  - Stateless `tools/call` without `initialize` is contract on `/api/mcp` and on profile URLs
    (`docs/mcp-workflow-profiles.md` «Connection and discovery»); `tools.listChanged` is `false`, so the catalog
    is refreshed on connect and after the error codes below.
  - Profile tool errors are JSON text `{error, errorCode?, details?}` with `isError: true`. Codes:
    `SCHEMA_REVISION_MISMATCH`, `INVALID_WORKFLOW_INPUT`, `MEDIA_INPUT_INVALID`, `WORKFLOW_UNAVAILABLE`,
    `PROFILE_ORGANIZATION_MISMATCH`, `INSUFFICIENT_TOKENS`, `GENERATION_FAILED`, `GENERATION_NOT_FOUND`. Every
    profile failure after the pending row is `GENERATION_FAILED` with `details.generationId`; `details` is a
    closed whitelist (`issues` ≤ 20, `generationId`, `requiredTokens`) and may be absent. A never-bound tool name
    is JSON-RPC `-32601`; a bound but unpublished one is `WORKFLOW_UNAVAILABLE`.
  - A generation tool's inline reply is `{generationId, status: 'completed', tokensCost, async: false, …outputs}`
    on synchronous success (`result_url`, `previewUrls`, `originalUrls`, `externalUrls`, `content_type`,
    `text_content`/`textContent`), or `{generationId, status: 'pending', tokensCost, async: true, jobId?}`
    (`functions/api/mcp/tools/executeWorkflow.ts:600-640`); a pipeline whose final read failed also answers
    `pending`/`async: true`. `on_behalf_of` is accepted by generation tools only; the upload tools reject it.
  - The profile route answers an unknown, disabled or other-organization profile with the same HTTP 404
    (`functions/api/mcp/s/[publicId].ts:25-26`). The plugin never sends a per-call `api_key`, so
    `PROFILE_ORGANIZATION_MISMATCH` is not expected.
  - Batches on a profile URL:
    - at most one generation `tools/call` per HTTP request;
    - upload, balance and status tools can be batched, ≤ 50 messages per batch;
    - batched messages run sequentially on the server;
    - one rate-limit unit per POST, 60/min per key by default.
  - `request_upload_url` rejects a MIME whose family differs from the declared `media_type`
    (`functions/api/mcp/tools/requestUploadUrl.ts:69-86`). `finalize_upload` reads, hashes and probes the R2
    object, up to ~10 s per object.
  - Media arguments accept only exact finalized URLs of the same organization; `x-loremax-media` (`version: 1`)
    gives `mediaType`, `role`, `cardinality`, `acceptedFormats`, `constraints`, `pairedWith`. Root
    `x-loremax-limits` gives the image/media position limits and the total bytes.
  - REST check (`POST /api/v2/generations/:id/check` with the `lmx_prod_` key) is not rate-limited and now
    answers HTTP 200 for terminal synchronous rows too (LoreMax b517f36e; «synchronous generations, which used to
    get 400»). Its body is `{generationId, status: completed|failed|checking, completed, error?, errorType?,
    result?: {previewUrls, originalUrls, externalUrls, contentTypes, textContent?}, contentType?, pipeline?}`;
    a 500 whose body says `completed: true` is a terminal failure. The body's `completed`/`status` are
    authoritative. A sync result is still finished directly from the execute reply (one fewer round trip), but
    handing it to the watcher is no longer unsafe — the 0.1.0 comment in `index.mjs:546` («/check would answer
    400») is stale and is corrected in Task 1.
  - The studio host dedupes `usage.record` by `(workspace, kind, ref)` (`host.ts:108-115`). `jobs.track` params
    survive until `settle`, which overwrites `result` (`host.ts:183-196`). `needsConfig` only flags the plugin
    and does not stop activation (`host.ts:234-240`). `PluginToolCall` has no abort signal, so handlers keep
    running after the client times out.
  - The test `z` is a no-op Proxy (`test/helpers.mjs:5-7`), so bounds must be enforced in code.

## Context (from discovery)
- Files: `index.mjs` (772 lines), `plugin.yaml`, `README.md`, `CHANGELOG.md`, `test/*.test.mjs` (92 tests, `npm test`),
  `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md`.
- Key code in `index.mjs`:
  - `createClient` (:67-191): `restJson` with 429 retry (:112-118), `mcpCall` without 429 retry (:137-174),
    `check` (:177-188);
  - `defaultWaitS` (:93-96); `EXT_BY_MIME` (:40-45); `resolveLocal` (:239-252); `saveOutputs` (:259-348);
  - `finish` (:355-391): `usage.record` without `ref` (:368-377);
  - `loremax_workflows` (:433-473);
  - `loremax_generate` (:486-571): "may have been charged" path (:524-537), sync branch (:546-549);
  - `loremax_result` (:573-615); `waitFor` (:619-659); watcher (:664-733).
- Test seams: `fakeCtx` / `mockFetch` (`test/helpers.mjs:14-98`), `activate(ctx, {pollMs, now})` with a fake clock,
  `watchOnce` returned from `activate`.
- Patterns: `bridex-plugin-fal` `fal_schema`/`fal_run` (schema as data plus a generic run tool).

## Development Approach
- **Testing approach**: Regular (code first, then tests in the same task)
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
- Maintain backward compatibility: REST mode and the 0.1.0 config keys keep working
- No dependencies (Node ≥ 20 built-ins only); behavior must not rely on zod bounds (the test `z` is a no-op)
- Stage 0 (Tasks 1-2) must work against the currently deployed LoreMax; Stage 1 (Tasks 3-9) targets the hardened
  contract. Profile fixtures in `test/fixtures/` are copied from the examples in LoreMax `docs/mcp-workflow-profiles.md`
  after the hardening plan; each fixture names its source and the LoreMax commit.

## Testing Strategy
- **Unit tests**: required for every task (see Development Approach above), `node --test test/` with `mockFetch`
  routes for REST, `/api/mcp`, the profile URL and R2 presigned PUT URLs; time-dependent behavior is driven by the
  injected `now` and `sleep` seams, never by real sleeps
- **E2E tests**: none in this repo; end-to-end checks against a deployed LoreMax are Post-Completion

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications
- **Checkbox placement**: Checkboxes belong only in Task sections (`### Task N:` or `### Iteration N:`). Do not put checkboxes in Success criteria, Overview, Context, Decisions, or Decision Log — they cause extra loop iterations.

## Decision Log
- 2026-10-11 plan-review: **accepted** - background success with a synchronous result is finished directly and woken, not handed to the watcher — Task 1. (2026-10-12 re-check: the original reason, «REST check answers 400 for sync rows», is gone since LoreMax b517f36e; the direct finish stays because it saves a round trip, not because polling would fail.)
- 2026-10-12 contract re-check: **accepted** - Text outputs are read from the REST check's `result.textContent` (not rate-limited) instead of a generic `/api/mcp` `check_generation` call; the MCP call stays only as a fallback — Task 2
- 2026-10-12 contract re-check: **accepted** - `on_behalf_of` is injected into generation calls only, never into `request_upload_url` / `finalize_upload` / `upload_from_url` (the upload tools reject it) — Tasks 7, 8
- 2026-10-12 contract re-check: **accepted** - the `loremax_workflows` detail reply never truncates the schema itself (LoreMax publishes schemas up to 64 KB); the cap applies to the prose around it — Task 6
- 2026-10-11 plan-review: **accepted** - restart-visible `submit:<uuid>` placeholder job and orphan handling in the watcher — Task 1
- 2026-10-11 plan-review: **accepted** - the budget is deadline-aware end to end: fetch timeouts, Retry-After sleeps, and no inline `finish` near the deadline — Tasks 1, 2, 4
- 2026-10-11 plan-review: **accepted** - the whole profile sequence (lookup, uploads, call, wait) runs inside the detached unit under one budget — Task 8
- 2026-10-11 plan-review: **accepted** - Text fallback whenever `finish` would report a completed generation with nothing to save, incl. sync replies — Task 2
- 2026-10-11 plan-review: **accepted** - upload dedupe by sha256 within a call, chunked request/finalize batches, chunk-level retry, pre-upload `x-loremax-limits` check — Task 7
- 2026-10-11 plan-review: **accepted** - generation tools detected by `schema_revision`, `_meta` only for identity — Decisions, Task 5
- 2026-10-11 plan-review: **accepted** - invalid `profile_url` never falls back to REST; PROFILE_NOT_FOUND hint names unknown/disabled profile and a key from another organization — Tasks 3, 8, 9
- 2026-10-11 plan-review: **accepted** - per-media-type MIME table and credential-scoped upload cache key — Task 7
- 2026-10-11 plan-review: **accepted** - injectable `sleep` test seam — Task 1
- 2026-10-11 plan-review: **accepted** - no detaching on older cores; explicit "do NOT call again" hint for `submitting` — Task 1
- 2026-10-11 plan-review: **accepted** - uncoded `isError` and `success` + `status: 'failed'` outcomes mapped — Task 8

## Implementation Steps

### Task 1: Keep every tool call under the client timeout (deadline-aware budget, detached submission)
- [ ] change `default_wait_s` to 45:
  - `cfg` default (`index.mjs:68-74`);
  - `defaultWaitS`: fallback 45 and clamp to 10..50 (`index.mjs:93-96`);
  - header sample (`index.mjs:12-18`);
  - `plugin.yaml` (`default: 45`, `maximum: 50`);
  - clamp `args.wait_s` in code, not only in zod: 10..50 for `loremax_generate`, 0..50 for `loremax_result`;
  - update both tool descriptions.
- [ ] add test seams to `activate(ctx, {pollMs, now, sleep})`: `sleep` (default real timer) drives the poll sleeps, the budget race and Retry-After waits, so tests advance a fake clock instead of sleeping
- [ ] compute `deadline = start + budgetMs` per tool call and thread it through `waitFor`, `check`, `restJson` and the later `rpc`:
  - every non-submission fetch timeout becomes `min(own, deadline - now())`;
  - a Retry-After that does not fit before the deadline is not slept: return `in_progress`;
  - when `waitFor` sees `completed` with less than ~10 s left, do not call `finish` inline: return `in_progress` without settling, so the watcher saves the files and wakes the agent.

  The paid submission request keeps its own long timeout (600 s): aborting it would not stop LoreMax.
- [ ] run the submission as a detached unit and race it against the deadline:
  - before starting it, when `ctx.jobs && ctx.wakeAgent`:
    - `ctx.jobs.track` a placeholder: `externalId: 'submit:<uuid>'`, the usual label and model, and `params: {submitting: true, mode, workflow/tool, note}`;
    - add the placeholder to `inFlight`.
  - if the unit answers before the deadline, continue as today: a sync result is finished directly; an async result is tracked and polled with the remaining budget.
  - if the deadline comes first, reply `{status: "submitting", hint: "submitted, still waiting for LoreMax — do NOT call loremax_generate again; end your turn, you will be WOKEN with the result"}`. When the unit later finishes:
    - **sync result** (`async !== true`, or a profile reply with `status: 'completed'` and outputs): call `finish` directly, never `/check`, then `wakeAgent({key: 'loremax-submit:<uuid>', sessionKey, prompt: files / left_on_cdn})`;
    - **async result**: `jobs.track` the real `generationId`, and the watcher wakes the agent on completion;
    - **definite failure**: wake the agent with the error;
    - **ambiguous failure**: wake with the existing "may have been charged" text.
  - in every case settle the placeholder (`succeeded` with `{workspace, generationId}`, or `failed`) and remove it from `inFlight`.
- [ ] watcher (`watchOnce`): a `submit:` row that is not in `inFlight` was left by a dead process. Settle it `failed` and wake the agent once with "the submission was interrupted by a restart; it may have been charged — check LoreMax history before running it again". Never call `check` for `submit:` rows. `loremax_result` and `fromRow` ignore them.
- [ ] on cores without `ctx.jobs` or `ctx.wakeAgent` do not detach: keep the 0.1.0 blocking submission (the polling budget still applies)
- [ ] fix the stale comment at `index.mjs:546` («/check would answer 400»): a sync reply is finished directly because its outputs are already in hand, not because the REST check would fail
- [ ] write tests in `test/generate.test.mjs` / `test/result-watcher.test.mjs`:
  - defaults and clamping;
  - slow sync execute: returns `submitting`, later `finish` and wake with files, and no `/check` call;
  - slow async execute: returns `submitting`, later tracked, then finished and woken by the watcher;
  - background definite and ambiguous failures wake with the right text;
  - a leftover `submit:` row after re-activation is settled and woken once, with no `/check`;
  - a normal fast call leaves no running `submit:` row;
  - completed near the deadline returns `in_progress` and the watcher finishes it;
  - a Retry-After of 30 near the deadline is not slept;
  - older core without `wakeAgent` blocks as in 0.1.0;
  - update `test/acceptance.test.mjs:108-109` and `test/generate.test.mjs:281-290`.
- [ ] run `npm test` - must pass before task 2

### Task 2: Idempotent spend, 429 retry for MCP calls, more output types and Text workflows
- [ ] pass `ref: String(job.generationId)` to `ctx.usage.record` in `finish` (`index.mjs:368-377`) so a repeated finish after a crash is counted once on the studio host
- [ ] add the same deadline-aware single 429 retry to `mcpCall` as `restJson` has (`index.mjs:112-118`); keep `errorCode` and `details` from an `isError` text on the thrown error (`err.code`, `err.details`) instead of dropping them
- [ ] extend `EXT_BY_MIME` / `MIME_BY_EXT` (`index.mjs:40-45`):
  - audio: `audio/mpeg` mp3, `audio/wav` wav, `audio/mp4` m4a, `audio/ogg` ogg, `audio/flac` flac, `audio/aac` aac;
  - video: `video/x-matroska` mkv, `video/mp2t` ts, `video/x-m4v` m4v;
  - 3D: `model/gltf-binary` glb, `model/gltf+json` gltf, `model/obj` obj, `model/stl` stl, `model/vnd.usdz+zip` usdz, `model/fbx` fbx.
- [ ] Text outputs. Text that is already in a reply (`textContent` / `text_content`, from the execute reply or a REST check's `result.textContent`) is saved as `<slug>-<generationId>.md` in the task artifacts through the same provenance / annotate / mirror path. When `finish` is about to report a completed generation with no files and no text (a sync execute reply without URLs), call the REST `check` once (it now answers 200 for sync rows and carries `result.textContent`); only if that body has no `result` at all, fall back to one generic `/api/mcp` `check_generation {generationId}` and read `text_content`.
- [ ] write tests:
  - usage `ref` is present in sync, async and watcher finishes (`test/save.test.mjs`, `test/result-watcher.test.mjs`);
  - `mcpCall` 429 retry and error code/details passthrough (`test/http.test.mjs`);
  - audio/glb/ts extension mapping (`test/save.test.mjs`);
  - text: a sync v2 execute reply without URLs leads to `check_generation`, saves the `.md` and records usage once; text from a REST check; text from a reply; the unchanged "no files" hint when there is really nothing (`test/generate.test.mjs`).
- [ ] run `npm test` - must pass before task 3

### Task 3: `profile_url` config and mode selection
- [ ] add `profile_url` to `plugin.yaml` `config_schema` (string, optional; full `https://…/api/mcp/s/<publicId>` URL or bare publicId) and a non-undefined default `""` in `cfg` (the acceptance test requires defaults for every key)
- [ ] add `profilePath()` to `createClient`:
  - empty → `null` (REST mode);
  - bare publicId (`/^[A-Za-z0-9]{16}$/`) → `/api/mcp/s/<id>` on `baseUrl()`;
  - full URL: must be http(s), on the same origin as `baseUrl()` (otherwise a config error naming both), with path `/api/mcp/s/<16 alnum>`.
- [ ] decide the mode once at `activate` and log it. For a non-empty invalid `profile_url`, call `ctx.needsConfig` and register the profile-mode tool set, whose handlers throw the config error. Never fall back to REST mode. REST mode stays as in Stage 0.
- [ ] write tests in `test/config.test.mjs`:
  - empty, bare id, full URL;
  - foreign origin, bad path, non-http;
  - an invalid value makes no REST call from any tool and returns the config error.

  Include `profile_url` in the yaml/cfg key-list test (`test/acceptance.test.mjs:102-104`).
- [ ] run `npm test` - must pass before task 4

### Task 4: Generalized JSON-RPC client for profile and generic endpoints
- [ ] add `rpc(path, payload, {timeoutMs, deadline})` to `createClient`:
  - Bearer auth; a single message or a JSON-RPC batch array (the caller keeps batches ≤ 50);
  - one deadline-aware 429 retry; non-JSON guard; per-message results keyed by id;
  - HTTP 404 on a profile path → error `PROFILE_NOT_FOUND`. It is not retryable, and its hint names all three causes: unknown profile, disabled profile, or a `LOREMAX_API_KEY` from another organization.
- [ ] add `toolCall(path, name, args, opts)` on top. It parses the text content. An `isError` result becomes an Error with:
  - `code` (`errorCode`, or `undefined` when uncoded) and `details`;
  - `charged: false` for the preflight codes (`SCHEMA_REVISION_MISMATCH`, `INVALID_WORKFLOW_INPUT`, `MEDIA_INPUT_INVALID`, `WORKFLOW_UNAVAILABLE`, `PROFILE_ORGANIZATION_MISMATCH`).

  JSON-RPC `-32601` → `code: 'TOOL_NOT_FOUND'`. "Insufficient tokens" or `INSUFFICIENT_TOKENS` → the out-of-funds card, as today.
- [ ] re-implement `mcpCall` as `toolCall('/api/mcp', …)` with no behavior change for REST mode
- [ ] write tests in `test/http.test.mjs`:
  - batch request/response matched by id;
  - 429 retry and deadline;
  - 404 profile with its hint;
  - each error code mapping, and the uncoded `isError`;
  - `-32601`;
  - the out-of-funds card fires once;
  - non-JSON body.
- [ ] run `npm test` - must pass before task 5

### Task 5: Profile catalog cache
- [ ] add `createProfileCatalog(lmx)` with `get({force})`: `tools/list` on the profile path, cached ~10 min, refreshed on `force` and after `SCHEMA_REVISION_MISMATCH`, `WORKFLOW_UNAVAILABLE`, `TOOL_NOT_FOUND`
- [ ] classify a tool as a generation tool when `inputSchema.properties.schema_revision` exists and its name is not in the known service set (`get_balance`, `check_generation`, `request_upload_url`, `finalize_upload`, `upload_from_url`); everything else is a service tool
- [ ] derive per generation tool:
  - `revision`: `inputSchema.properties.schema_revision.enum[0]`;
  - `agentSchema`: a deep copy without `schema_revision`, `api_key` and `on_behalf_of` in `properties` and `required`; vendor keys `x-loremax-*` are kept;
  - `fileArgs`: for each property with `x-loremax-media`, the name, `mediaType`, `role`, `cardinality`, `acceptedFormats`, `constraints` and `pairedWith`;
  - `limits`: root `x-loremax-limits`;
  - `identity`: from `_meta['loremax.ai/workflow']`, else `{title: tool.title ?? name}` (logged once);
  - `title` and `description`.
- [ ] tolerate an unknown `x-loremax-media.version` (treat it as a plain URL argument and log once) and never throw on unexpected JSON
- [ ] write tests with fixtures copied from the LoreMax docs (`test/fixtures/profile-tools-list.json`, with text, image-with-mask and controller tools):
  - split and classification, including a tool without `_meta` that has `schema_revision`;
  - revision extraction and stripped fields;
  - `fileArgs` and `limits`;
  - identity and its fallback;
  - TTL and forced refresh;
  - malformed entries are skipped.
- [ ] run `npm test` - must pass before task 6

### Task 6: `loremax_workflows` in profile mode
- [ ] in profile mode register `loremax_workflows` with schema `{tool?: string, query?: string}` and a mode-specific description (curated profile, free, no price). Without `tool`, list `{tool, title, category, description (first ~200 chars), required, file_args: [{name, mediaType, cardinality}]}`, filtered by `query` over tool, title, category and visualId.
- [ ] with `tool`, return `{tool, title, description, schema: agentSchema, file_args (full), limits, how_to_call}`. The cap never cuts `schema` (LoreMax publishes schemas up to 64 KB): when the reply exceeds `REPLY_CAP`, shorten `description` and `how_to_call` first and, if still over, raise the cap for this reply to the schema's size plus 2 KB. `how_to_call` explains that file arguments take workspace paths (`artifacts/…` or workdir files) and that conditional rules live in `x-loremax-conditions`. An unknown tool triggers one refresh, then "no such tool" with the list of names.
- [ ] REST mode keeps the 0.1.0 behavior and description unchanged
- [ ] write tests in `test/workflows.test.mjs`: profile list, query filter, details, reply cap, unknown-tool refresh, REST mode untouched
- [ ] run `npm test` - must pass before task 7

### Task 7: Upload workspace files for file arguments
- [ ] add `uploadFiles(call, tool, args, {deadline})`. For each `fileArgs` entry whose value is a path or an array of paths:
  - apply `resolveLocal` (the path jail);
  - check the extension against `acceptedFormats`;
  - check the size against `constraints` and ≤ 50 MiB;
  - check the array length against `cardinality`.

  Before any upload, check the totals against `limits`: non-mask image positions, all positions, and unique bytes. An `https://` value is passed through unchanged; the server accepts only finalized same-organization URLs.
- [ ] MIME by `(mediaType, ext)`:
  - audio: mp4/m4a→`audio/mp4`, mp3→`audio/mpeg`, wav→`audio/wav`, ogg→`audio/ogg`, aac→`audio/aac`, flac→`audio/flac`;
  - video: mp4→`video/mp4`, mov→`video/quicktime`, webm→`video/webm`, mkv→`video/x-matroska`, ts→`video/mp2t`, m4v→`video/x-m4v`;
  - images: the existing map;
  - models: canonical `model/*` (glb `model/gltf-binary`, gltf `model/gltf+json`, obj `model/obj`, stl `model/stl`, usdz `model/vnd.usdz+zip`, fbx `model/fbx`).
- [ ] dedupe identical files within the call by sha256, then upload:
  1. `request_upload_url {filename, mime, media_type, size_hint: exact size}` in batches of ≤ 50 messages — no `on_behalf_of` and no `api_key` on any upload tool (they reject `on_behalf_of`);
  2. `PUT` each file with exactly the returned headers;
  3. `finalize_upload {asset_id}` in small chunks (≤ 5 files or ≤ 100 MiB per POST) with an rpc timeout scaled to the chunk bytes.

  A lost or timed-out finalize chunk re-uploads only its own files (server dedup returns the same asset). Replace the paths with the returned `url` values in their original order.
- [ ] cache `sha256(apiKey) + mediaType + sha256(file) → finalized url` in memory for ~1 h per process to skip repeat uploads. Any upload failure aborts before generation with "nothing was charged".
- [ ] write tests in a new `test/upload.test.mjs`:
  - single and array args;
  - format, size and `limits` rejection before any HTTP call;
  - jail escape rejected;
  - an audio `.mp4` is requested as `audio/mp4`;
  - batches of 60 files are chunked;
  - PUT headers are exact;
  - a finalize-chunk timeout re-uploads only that chunk;
  - an in-call duplicate is uploaded once;
  - a cache hit skips the upload, and a key change misses;
  - an https URL passes through;
  - a partial failure makes no generation call.
- [ ] run `npm test` - must pass before task 8

### Task 8: `loremax_generate` in profile mode
- [ ] in profile mode register `loremax_generate` with schema `{tool: string, arguments: record, wait_s?, note?}` and a mode-specific description: paid per call; read the tool with `loremax_workflows` first; file arguments take workspace paths.
- [ ] the whole profile sequence runs inside the Task 1 detached unit under the one budget measured from tool start: catalog lookup → `uploadFiles` → `toolCall(profilePath, tool, args, {timeoutMs: 600_000})` → wait. On older cores (no detaching), abort with "nothing was charged; uploads are cached — call loremax_generate again" when less than ~15 s of budget is left after the uploads. Never start the paid call after the budget has elapsed unless the tool has already replied `submitting`.
- [ ] arguments: the agent arguments with uploaded URLs, plus the cached `schema_revision` and `on_behalf_of = bridex:<workspace>:<agent>` (reduced to `[A-Za-z0-9._:@ -]`, trimmed, ≤ 128); never `api_key`
- [ ] map outcomes:
  - `INVALID_WORKFLOW_INPUT` / `MEDIA_INPUT_INVALID` → "not charged" with `details.issues` and the tool schema;
  - `SCHEMA_REVISION_MISMATCH` → force-refresh the catalog and reply "not charged — schema changed" with the fresh schema (no auto-retry);
  - `WORKFLOW_UNAVAILABLE` / `TOOL_NOT_FOUND` → refresh and reply "tool unavailable" with the current tool list;
  - `PROFILE_NOT_FOUND` / `PROFILE_ORGANIZATION_MISMATCH` → config error with the three-cause hint;
  - `INSUFFICIENT_TOKENS` → out-of-funds card and a reply;
  - `GENERATION_FAILED`, an uncoded `isError`, or a success reply with `status: 'failed'` → reply failed with the error and `generationId` when present, plus "LoreMax refunds failed runs — check history, do not retry blindly"; no tracking and no usage;
  - no reply → the existing "may have been charged" text.
- [ ] on success, if the reply carries outputs (`originalUrls`/`previewUrls`/`externalUrls`/`textContent`) and `status: 'completed'`, call `finish` directly. Otherwise, including a pipeline reply without URLs, `ctx.jobs.track` with `params: {mode: 'profile', tool, arguments (workspace paths, not URLs), references, tokensCost, note, identity}` and wait via the REST `check` in `waitFor`.
- [ ] provenance and usage:
  - `generation.workflow = identity.visualId ?? identity.title ?? tool`;
  - `params` = the agent's arguments with workspace paths, plus `image_urls` = all referenced paths (for the studio ProvenanceCard thumbnails), plus `tool` and `profile`;
  - `usage.record`: `model` = the same workflow label, `ref` = `generationId`;
  - the job label keeps `<note> · <n> tk`.
- [ ] make `fromRow`, `loremax_result` and the watcher accept both REST and profile job params (restart-safe); REST mode unchanged
- [ ] write tests in `test/generate.test.mjs` (profile section):
  - happy path with uploads;
  - injected `schema_revision` and `on_behalf_of`, with sanitization;
  - each error mapping, including uncoded `isError` and `status: 'failed'`;
  - nothing charged on preflight errors;
  - slow uploads return `submitting`, then a later wake, and never an unawaited paid call after the budget;
  - older-core abort;
  - pipeline reply without URLs gets tracked and polled;
  - completed reply with text gets saved;
  - provenance and usage fields;
  - restart: the watcher finishes a profile job from persisted params (`test/result-watcher.test.mjs`).
- [ ] run `npm test` - must pass before task 9

### Task 9: Health check and balance tile in profile mode
- [ ] in profile mode call `get_balance` on the profile path (same key) for `registerCheck`/`registerStat`, and make the check also report the number of generation tools from `tools/list` ("profile reachable, N tools")
- [ ] fail the check with the three-cause hint on `PROFILE_NOT_FOUND`, and with the config error for an invalid `profile_url`
- [ ] write tests in `test/result-watcher.test.mjs` (or a new `test/health.test.mjs`): profile check ok, 404 profile, invalid config, empty balance, REST mode unchanged
- [ ] run `npm test` - must pass before task 10

### Task 10: Verify acceptance criteria
- [ ] verify the Overview items:
  - the Stage 0 fixes are active in REST mode against today's LoreMax behavior (sync rows never polled);
  - profile mode covers catalog, uploads, generation, error mapping, polling, provenance and usage.
- [ ] verify edge cases:
  - empty `profile_url` behaves like 0.1.0 plus the Stage 0 fixes;
  - no tool call exceeds the 50 s budget under slow-network fakes (submission, uploads, Retry-After, downloads);
  - background submissions and the watcher never double-finish;
  - a restart during a submission yields exactly one wake.
- [ ] run the full suite `npm test`
- [ ] review coverage of new functions by reading the test list against the code paths (the repo has no coverage tool); add missing cases

### Task 11: [Final] Update documentation
- [ ] `README.md`:
  - profile mode: what a LoreMax profile is, getting the URL in `/organization/mcp`, a config example with `profile_url`;
  - the tools table for both modes;
  - file arguments with workspace paths and upload limits;
  - the error codes the agent may see;
  - `default_wait_s` 45 and the `submitting` reply;
  - Text outputs saved as `.md`;
  - the "For the studio" section: with a profile, `studio/art-guide.md` names profile tools instead of workflow ids.
- [ ] `CHANGELOG.md` 0.2.0 entry; `plugin.yaml` `version: 0.2.0`
- [ ] update `docs/backlog/cli-mcp-tool-timeout-vs-long-waits.md`:
  - the 60 s SDK default is confirmed for the llm adapter (studio `mcpClient.ts:154`, SDK 1.29.0);
  - the plugin now caps its own budget at 50 s and detaches submissions;
  - fix the stale `waitFor` line reference.

## Technical Details
- **Profile URL**: `https://<base>/api/mcp/s/<publicId>`; same `Authorization: Bearer <lmx_prod_…>`; stateless
  JSON-RPC POST, no `initialize` needed.
- **Generation call args**: `{...agentArgsWithUploadedUrls, schema_revision, on_behalf_of}`; never `api_key`.
- **Upload sequence**:
  1. `request_upload_url {filename, mime, media_type, size_hint}` → `{asset_id, upload_url, headers, expires_at}`,
     in batches of ≤ 50;
  2. `PUT upload_url` with exactly `headers`;
  3. `finalize_upload {asset_id}` → `{url, …}`, in chunks of ≤ 5 files or ≤ 100 MiB.
- **Job params (profile)**: `{mode: 'profile', tool, arguments, references, tokensCost, note, identity: {workflowId,
  visualId, title, category, contentType, pipeline}}`. Placeholder: `externalId: 'submit:<uuid>'`,
  `params: {submitting: true, mode, workflow|tool, note}`.
- **Budget**: `budgetMs = clamp(wait_s ?? default_wait_s, 10, 50) * 1000`, `deadline = start + budgetMs`.
  Non-submission fetches and sleeps never extend past the deadline. The submission request keeps its own 600 s
  timeout inside the detached unit. Inline `finish` happens only with ≥ ~10 s left.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Prerequisites for Stage 1**:
- LoreMax `main` with the profiles and hardening is pushed (2026-10-12), but `docs/mcp-workflow-profiles.md` «External
  rollout» says migration 078 on prod D1, the Pages deploy and the smoke checks have not been performed yet. Stage 1
  can only be verified live after that, plus a studio profile created in `/organization/mcp` with its URL in the
  plugin config. Stage 0 needs none of it.

**Manual verification**:
- On a studio instance:
  - list workflows;
  - generate with two references and a mask;
  - a long video (> 5 min) that returns `submitting`/pending and later wakes the agent;
  - a slow synchronous workflow, which is finished without `/check`;
  - a text workflow;
  - a schema change in LoreMax followed by a call (the revision-mismatch path);
  - a server restart during a submission, which gives one wake;
  - a disabled profile: config error, while in-flight jobs still finish via REST polling.

**External system updates**:
- Bridex host: set `tool_timeout_sec` for codex in `server/src/runtime/cliMcpConfig.ts` and pass a timeout to
  `callTool` in `server/src/runtime/mcpClient.ts` (or add a "caller gone" signal for plugin tools). Then the 50 s
  cap can be relaxed.
- Bridex plugin catalog/registry: publish 0.2.0.
- Studio wiki `studio/art-guide.md`: reference profile tool names per asset kind.
