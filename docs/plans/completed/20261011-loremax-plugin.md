# LoreMax catalog plugin — workflows, generation, provenance

## Overview
- A Bridex catalog plugin `loremax` (this repository, `plugin.yaml` + `index.mjs`) that lets agents generate images and video
  through LoreMax (`https://loremax.ai`, the operator's own generation service): list the organization's workflows, read a
  workflow's input fields and price, run a workflow with inputs passed through unchanged and reference files taken from
  the workspace artifacts, and get the outputs saved into the task's artifacts with provenance and token spend.
- Solves: the studio's illustrator today has only `media` (OpenRouter) and `fal`; the user wants art and video made
  through their own service with the organization's API key, and wants to evolve the integration without redeploying
  Bridex — a catalog plugin updates from the dashboard (`installPlugin`/update → `activatePlugin`).
- Integrates like `bridex-plugin-fal`: `ctx.registerTool`, `ctx.jobs.track/settle/pending`, `ctx.artifacts.annotate/mirror`,
  `ctx.usage.record`, `ctx.billing.outOfFunds`, `ctx.registerCheck`, `ctx.registerStat`, `ctx.wakeAgent`. The studio's
  Source card reads `generation.params.image_urls` for reference thumbnails, so no UI change is needed.

## Decisions
- **Context**: three ways to reach LoreMax from Bridex were weighed on 2026-10-11 — a remote MCP server entry in
  `bridex.yaml` (LoreMax has `/api/mcp`), a built-in plugin in Bridex core (like `media`), a catalog plugin (like `fal`),
  and a `provider: loremax` inside `media`.
- **Chosen approach**: catalog plugin. Same agent-facing contour as `media`/`fal` (artifacts, provenance, spend, queue
  tracking, agent wake-up, health check), curated 3 tools instead of LoreMax's 24 MCP tools, and it updates from the
  dashboard without a Bridex release.
- **Rejected alternatives**: built-in plugin — every change needs a Bridex release; remote MCP only — the agent must
  download outputs itself with curl, no `jobs.track`/`wakeAgent`, no health check, 24 tools in every agent's context;
  provider inside `media` — `media`'s unit is prompt+model, LoreMax's unit is a workflow with its own widget fields, and
  one provider per instance would drop OpenRouter.
- **Also decided**: default workflows per asset kind live in the studio's `studio/art-guide.md` wiki page (people edit
  it, the illustrator reads it before every picture), not in `project.yaml`; LoreMax's reference library, `plan_generation`
  and preview files as separate artifacts are out of scope; `usd_per_token` is an optional config number for the spend
  charts (absent = tokens only).
- **Verified facts (LoreMax, repo fluxgenenerator)**:
  - auth `X-API-Key: lmx_prod_<32>` or `Authorization: Bearer …` (`functions/utils/apiKeyAuth.ts`, `apiKeyGenerator.ts:118-135`);
    the same key authenticates the MCP endpoint with scope `full` (`functions/api/mcp/index.ts:296`).
  - `GET /api/v1/workflows` → `{workflows:[{id, visualId, title, description, category, isEnabled}]}` (`functions/api/v1/workflows.ts:43-79`).
  - `POST /api/v2/workflow/execute` — JSON `{workflowId, inputs}` or multipart form fields `workflowId`, `inputs` (JSON
    string), `fileCount`, `file_0..file_N` (≤ 20; uploads are routed into `image_urls`/`video_urls`/`audio_urls` by type)
    → `{generationId, status:"pending", tokensCost, checkStatusUrl, jobId, async:true}`; 402 `Insufficient tokens`;
    429 with `Retry-After`; limits 60/min, 1000/h (`functions/api/v2/workflow/execute.ts`).
  - `POST /api/v2/generations/:id/check` → `{status:"pending"|"checking"|"completed"|"failed", result?:{previewUrls[],
    originalUrls[], contentTypes[]}, error?, errorType?}`; HTTP 500 when failed (`functions/api/v2/generations/[id]/check.ts`).
    Output URLs are public (R2 custom domain or `https://<bucket>.r2.dev`, `R2UploadService.ts:39-53`).
  - REST has no workflow-details or pricing endpoint. They exist only as MCP tools at `POST /api/mcp` — Streamable
    HTTP, JSON responses, STATELESS: `tools/call` works without `initialize` (`McpProtocolHandler.ts:163-168, 341-352`).
    `get_workflow_details {workflowId}` → `data.input_fields[{key,type,label,config}]`, `data.usage_hint`,
    `data.pricing_variables_required?`; `get_pricing {workflowId, inputs?}` → `data.tokenCost`; `get_balance {}` →
    `data.{limit, used, remaining}`. Tool results are `{success, data}` or `{success:false, error}` JSON in the
    JSON-RPC result's text content.
  - ⚠️ corrected in the code review (checked against `McpProtocolHandler.ts:562-601`, `schemas/mcp.ts:366-368`,
    `execute.ts:567-603`, `check.ts:184-190`): `get_workflow_details` takes `{visual_id}` (numeric ids also resolve),
    not `{workflowId}`, and returns a flat object (`id, visual_id, title, …, input_fields, usage_hint`); a tool's text
    content is the `data` itself, and a failed tool sets `isError: true` with `{"error": "…"}` text (no `success`
    wrapper, no SSE, no `structuredContent`); an execute that finishes right away returns `originalUrls`/`previewUrls`
    without `async` and its `/check` answers 400, so the plugin saves those outputs directly. The job label carries the
    token spend (`<note> · <n> tk`) so a restart doesn't lose it. `LOREMAX_BASE_URL` is in `requires_env`, so the host
    won't start the plugin until it is set — the "empty = default" path only applies to `config.base_url`.
- **Verified facts (Bridex host, branch `studio`)**: `PluginContext` in `server/src/plugins/types.ts:108-230` (registerTool,
  registerCheck, registerStat, needsConfig, billing.outOfFunds, artifacts.annotate/mirror, jobs.track/settle/find/pending,
  usage.record, wakeAgent, paths.workspaceArtifacts/workspaceWorkdir, z, log); `plugin.yaml` `requires_env` names become
  managed credentials settable in Settings → Integrations (`server/src/plugins/host.ts:305` → `declareCredential`), and
  names ending `_BASE_URL` are normalized by the core; `ProvenanceCard.tsx:15-20` reads `params.input_references`, then
  `params.image_urls`, then `params.image_url`.

## Context (from discovery)
- Files/components involved: `plugin.yaml`, `index.mjs`, `package.json`, `README.md`, `test/*.test.mjs` (all new).
- Related patterns found in `/Users/echeg/Projects/bridex/bridex-plugin-fal/index.mjs`: `resolveRef` for `${ENV}` config
  values (:45), `falJson` with 402 → `ctx.billing?.outOfFunds?.` (:57-72), `resolveLocal` path jail (:84-95),
  `collectFiles`/`saveOutputs` with `EXT_BY_MIME` and a download cap (:97-145), `finish` → annotate + `usage.record` +
  `jobs.settle` (:166-185), `fal_run` track-from-the-first-second + poll loop + timeout hint (:293-330), `fal_result`
  (:333-351), the reboot-proof watcher over `ctx.jobs.pending()` with a 6 h give-up and `ctx.wakeAgent` (:364-400).
  `media.ts` caps inline references at 20 MB (`REF_CAP`).
- Dependencies identified: none beyond Node ≥ 20 (`fetch`, `FormData`, `Blob`, `node:test`). Catalog plugins have no
  `node_modules`; `ctx.z` provides zod.
- Catalog plugins have no tests today (`hello`, `fal`, `elevenlabs`); this one ships with `node --test`.

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
- Keep `index.mjs` loadable by older Bridex cores: guard `ctx.billing?.`, `ctx.jobs`, `ctx.wakeAgent`, `ctx.registerStat?.`
  like fal does

## Testing Strategy
- **Unit tests**: `node --test test/` with a fake `ctx` (records `registerTool`/`registerCheck`/`registerStat`/`needsConfig`
  calls, `jobs` kept in an in-memory array, `artifacts.annotate`/`mirror` and `usage.record` recorded, `paths` pointing at a
  temp dir, `wakeAgent` recorded, `z` from a tiny stand-in or the real zod if present in the test environment — the
  plugin only needs `z.string()/number()/record()/array()/object()` with `.optional()/.describe()/.min()/.max()/.int()`)
  and a mocked `globalThis.fetch` that routes by URL and method and records request bodies (JSON and `FormData`).
- No e2e tests in this repository.

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
- 2026-10-11 brainstorm: **rejected** - "built-in plugin in Bridex core (the 2026-10-10 idea)" - every change would need a Bridex release; the user asked which option evolves without redeploying.
- 2026-10-11 brainstorm: **rejected** - "remote MCP server entry only" - the agent downloads files itself, no jobs/wakeAgent/health check, 24 tools in context.
- 2026-10-11 brainstorm: **rejected** - "provider: loremax inside media" - unit mismatch (prompt+model vs workflow+fields) and it would drop OpenRouter on the instance.
- 2026-10-11 brainstorm: **accepted** - default workflows per asset kind go to `studio/art-guide.md` (Bridex-side plan), not to this plugin's config or `project.yaml`.
- 2026-10-11 brainstorm: **accepted** - CP passes both `LOREMAX_API_KEY` and `LOREMAX_BASE_URL` to studio instances (separate bridex-cp plan); this plugin reads them as managed credentials.

## Implementation Steps

### Task 1: Manifest, package and the plugin skeleton
- [x] create `plugin.yaml`: `name: loremax`, `version: 0.1.0`, `kind: integration` (comment why, as fal does), `description`,
      `entry: index.mjs`, `requires_env: [LOREMAX_API_KEY, LOREMAX_BASE_URL]`, `config_schema` with `api_key` (string,
      secret, `credential: LOREMAX_API_KEY`, placeholder `${LOREMAX_API_KEY}`), `base_url` (string, `credential:
      LOREMAX_BASE_URL`, placeholder `${LOREMAX_BASE_URL}`, description "default https://loremax.ai"), `default_wait_s`
      (integer, default 180, 10..1500), `usd_per_token` (number, minimum 0, description "price of one LoreMax token in USD
      for the spend charts; empty = record tokens only")
- [x] create `package.json` (`"type": "module"`, `"private": true`, `"scripts": {"test": "node --test test/"}`, no dependencies)
- [x] create `index.mjs` with `export default async function activate(ctx)`: `cfg = { api_key: "${LOREMAX_API_KEY}",
      base_url: "${LOREMAX_BASE_URL}", default_wait_s: 180, usd_per_token: 0, ...ctx.config }`; `resolveRef` for `${ENV}`;
      `key()` throws "LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax" when empty; `baseUrl()` = resolved
      `base_url` or `https://loremax.ai`, trailing slashes stripped, must be http(s) or throw; when the key is unset at
      activate call `ctx.needsConfig(...)` once (tools still register, each call surfaces the error)
- [x] add `restJson(path, init, timeoutMs)`: `X-API-Key` header, `AbortSignal.timeout`, non-JSON guard; on 402 or
      `/insufficient tokens/i` call `ctx.billing?.outOfFunds?.({ provider: "LoreMax", what: "image and video generation
      (loremax plugin)", detail })` then throw; on 429 wait `Retry-After` seconds (cap 30 s) and retry once, then throw
      `loremax 429 …`; other errors throw `loremax <status> <path>: <body ≤ 400 chars>`
- [x] add `mcpCall(tool, args)`: `POST ${baseUrl()}/api/mcp` with `Authorization: Bearer <key>`, `Content-Type` and
      `Accept: application/json`, body `{jsonrpc:"2.0", id, method:"tools/call", params:{name: tool, arguments: args}}`;
      parse `result.content[0].text` as `{success, data|error}` (also accept `result.structuredContent`); throw on
      JSON-RPC `error` or `success: false` with the LoreMax error text
- [x] write tests `test/config.test.mjs`: `${ENV}` resolution, base_url default and normalization (trailing slash,
      rejects `ftp://`), missing key → `needsConfig` recorded and a tool call throws the Settings hint
- [x] write tests `test/http.test.mjs`: `restJson` sends `X-API-Key`; 402 → `outOfFunds` recorded + throw; 429 with
      `Retry-After: 1` → one retry then success; 429 twice → throw; `mcpCall` builds a `tools/call` envelope with Bearer
      and unwraps `{success,data}`, throws on `{success:false,error}` and on a JSON-RPC error object
- [x] run `npm test` - must pass before task 2
- ➕ note: the client lives in an exported `createClient(ctx)` (the default `activate` uses it) so tests reach
      `restJson`/`mcpCall` directly; `mcpCall` sends `Accept: application/json, text/event-stream` (the Streamable HTTP
      pair) and also parses an SSE-framed reply; errors carry `status`/`body` for the task 4 `failed` path and the check

### Task 2: `loremax_workflows` — list, fields and price
- [x] register `loremax_workflows` with schema `{ workflow_id?: string, query?: string }` and a description saying it is
      free, lists the organization's workflows, and with `workflow_id` returns the input fields and price — read it before
      a paid `loremax_generate`
- [x] without `workflow_id`: `GET /api/v1/workflows`, map to `{id, visual_id, title, category, description ≤ 200 chars}`,
      filter by `query` (case-insensitive substring over title/description/visual_id/category), reply `{workflows, hint}`
- [x] with `workflow_id`: `mcpCall("get_workflow_details", { workflowId })` → `{ workflow: {id, visual_id, title, category,
      description}, input_fields, usage_hint, pricing_variables_required? }`, then `mcpCall("get_pricing", { workflowId })`
      → `token_cost` (price failure is reported as `price: "unavailable: <reason>"`, not a tool error); cap the reply at
      14 000 chars like `fal_schema`
- [x] write tests `test/workflows.test.mjs`: list mapping and query filter; details merge fields + price; details with a
      failing `get_pricing` still returns fields; unknown workflow → LoreMax error text surfaces
- [x] run `npm test` - must pass before task 3

### Task 3: Output saving with provenance
- [x] add `resolveLocal(ws, p)` (copy of fal's jail: `artifacts/…` → `paths.workspaceArtifacts`, else relative to
      `paths.workspaceWorkdir`; outside → throw; missing → throw) and `EXT_BY_MIME`/`MIME_BY_EXT` maps for png/jpg/webp/gif/
      svg/mp4/webm/mov
- [x] add `saveOutputs(call, workflowSlug, generationId, result, note, generation)`: URLs = `result.originalUrls` when
      non-empty else `result.previewUrls`; download each with `redirect: "follow"`, 300 s timeout, 512 MB cap (skip and
      warn above it); extension from `result.contentTypes[i]`, else the response `Content-Type`, else the URL path, else
      `bin`; file `artifacts/<call.taskId ?? "loremax">/<workflowSlug>-<generationId>[-<i+1>].<ext>`; `ctx.artifacts.annotate`
      with `{agent, taskId, description: "LoreMax <workflow> · generation <id> · <note>" ≤ 300, action: "generated",
      generation}`; `ctx.artifacts.mirror(ws, rels)`; return `rels`
- [x] add `finish(call, job, check)`: builds `generation = { provider: "LoreMax", workflow: <visual_id or id>, params:
      {...inputs, ...(references.length ? { image_urls: references } : {})}, externalId: String(generationId),
      ...(costUsd ? { costUsd } : {}) }` where `costUsd = tokensCost * cfg.usd_per_token`; calls `saveOutputs`;
      `ctx.usage.record({ workspace, agent, kind: "loremax", model: workflow, costUsd, units: tokensCost, unit: "tk", taskId })`;
      `ctx.jobs?.settle(trackedId, { status: "succeeded", result: { artifacts, tokensCost } })`; returns the tool reply
      `{ generation_id, status: "completed", workflow, artifacts, tokens_cost, cost_usd?, hint: "reference outputs as
      [media: artifacts/<path>]" }`
- [x] write tests `test/save.test.mjs`: two outputs with `contentTypes` → two files named `<slug>-<id>-1.png`,
      `<slug>-<id>-2.webp`, sidecar `generation` carries provider/workflow/params with `image_urls`/externalId/costUsd,
      `mirror` called with both rels, `usage.record` carries units/unit and costUsd (0 when `usd_per_token` unset);
      `previewUrls` fallback; a failed download is skipped with a warning; the jail rejects `../outside.png` and a path
      outside the workspace; files over the cap are skipped
- [x] run `npm test` - must pass before task 4
- ➕ note: the jail, `saveOutputs` and `finish` live in an exported `createOutputs(ctx, lmx, { downloadCap })` so tests
      reach them directly; `finish(call, job, check)` takes `job = { generationId, workflow, inputs, references, tokensCost,
      trackedId, note }` and returns the reply as an object (task 4's tool and task 5's watcher both use `artifacts`);
      a declared `Content-Length` over the cap is skipped before the body is pulled; a reply with no files already says so

### Task 4: `loremax_generate` — execute, track, wait
- [x] register `loremax_generate` with schema `{ workflow_id: string, inputs: record, references?: string[] (max 20),
      wait_s?: int 10..1500, note?: string ≤ 200, }` and a description: inputs exactly as `loremax_workflows` names them,
      references are `artifacts/…` paths or workspace files (each ≤ 20 MB) sent as files, outputs land in the task's
      artifacts with provenance, every call is PAID in LoreMax tokens, read the price first, on timeout you get a
      `generation_id` and are WOKEN when it lands
- [x] build the request: without references `POST /api/v2/workflow/execute` JSON `{ workflowId, inputs }`; with references
      a `FormData` with `workflowId`, `inputs` (JSON string), `fileCount`, `file_<i>` as `Blob` (type from `MIME_BY_EXT`,
      filename = basename) after `resolveLocal` and a 20 MB per-file check
- [x] on `{generationId, tokensCost}`: `ctx.log.info`, `trackedId = ctx.jobs?.track({ workspace, agent, taskId, sessionKey,
      runId, externalId: String(generationId), model: workflow_id, label: note ?? inputs.prompt?.slice(0,120) ?? "" })`;
      remember `{ inputs, references, tokensCost, workflow }` in an in-memory map by generationId (the watcher in task 5
      falls back to the job row when the map is empty after a restart)
- [x] poll `POST /api/v2/generations/<id>/check` every 3 s until `wait_s` (default `cfg.default_wait_s`): `completed` →
      `finish`; `failed` (or HTTP 500 with `status: "failed"`) → `jobs.settle failed` with `error`/`errorType` and throw
      `LoreMax generation <id> failed: <error>`; `pending`/`checking` → keep waiting; on timeout reply `{ generation_id,
      status: "in_progress", tokens_cost, hint: jobs ? "still rendering after Ns — end your turn if nothing else is
      pending: you will be WOKEN when it lands (or poll loremax_result)" : "… call loremax_result" }`
- [x] write tests `test/generate.test.mjs`: JSON path end to end (execute body, check polled until completed, artifacts
      written, annotate/usage/settle recorded, reply shape); multipart path (body is `FormData` with `fileCount: 2`,
      `file_0`/`file_1` blobs, `inputs` JSON string; `generation.params.image_urls` lists the two reference paths); a
      reference outside the workspace or over 20 MB throws before any HTTP call; timeout returns `in_progress` and the job
      stays tracked; `failed` check settles the job as failed and throws with LoreMax's error; 402 on execute → `outOfFunds`
      and no job tracked
- [x] run `npm test` - must pass before task 5
- ➕ note: `activate(ctx, { pollMs, now })` takes a test-only second argument (poll interval and clock; the host passes
      only ctx); the `/check` call is `lmx.check(id)` in `createClient` (it turns LoreMax's HTTP 500 `status: "failed"`
      body into a normal reply) so the task 5 watcher reuses it; a check that errors any other way throws with the
      generation id and a `loremax_result` hint and leaves the job tracked; the in-memory map lives inside `activate`

### Task 5: `loremax_result`, the reboot-proof watcher, check and balance tile
- [x] register `loremax_result` with schema `{ generation_id: string, wait_s?: int 0..1500 }`: find the tracked job via
      `ctx.jobs?.find(generation_id)` (a finished one returns its stored `result` without a new download); otherwise poll
      `check` up to `wait_s` (default 0 → one check) and `finish` on completed, `in_progress` reply otherwise; the
      `generation` params come from the in-memory map or, after a restart, `{ workflow: job.model }` only
- [x] add the watcher (like fal :364-400): `setInterval` 15 s over `ctx.jobs.pending()`; give up after 6 h with `settle
      failed`; `completed` → `finish` then `ctx.wakeAgent({ workspace, agent, key: "loremax-job:<job.id>", sessionKey,
      prompt: "LoreMax generation <id> (<workflow>) finished: <artifacts list> — continue where you left off" })`;
      `failed` → settle failed + wake with the error; errors are logged, never thrown; `unref()` the interval and clear it
      in `ctx.onShutdown`
- [x] add `ctx.registerCheck`: no key → `{ ok: false, message: "no key: LOREMAX_API_KEY is not set" }`; `mcpCall("get_balance")`
      → `remaining > 0` ? `key works · <remaining> tk left` : `key works, but the balance is empty — top up LoreMax`;
      HTTP/auth failure → `LoreMax refused the key (<status or message>)`
- [x] add `ctx.registerStat?.(…)`: one tile `{ label: "LoreMax balance", value: "<remaining> tk", warn: remaining <
      cfg.low_balance_tokens? }` — skip `low_balance_tokens` unless the stat tile type requires a flag; cache the balance
      60 s; on error return `[]`
- [x] write tests `test/result-watcher.test.mjs`: `loremax_result` on a finished job returns the stored result without
      fetch; on a pending job polls once and returns `in_progress`; with `wait_s` finishes and saves; the watcher
      finishes a pending job and records `wakeAgent` with the artifacts, settles failed on `failed` and gives up after 6 h
      (fake `createdAt`); `registerCheck` three outcomes; the stat tile caches for 60 s (fetch called once for two reads)
- [x] run `npm test` - must pass before task 6
- ➕ note: `loremax_generate` and `loremax_result` share one `waitFor` poll (always one check, then until `wait_s`);
      generation ids a tool call is polling are skipped by the watcher (no double download/settle); `loremax_result`
      returns a settled-failed job's error as `status: "failed"`; the watcher wakes the agent on the 6 h give-up too and
      treats any check error as transient (logged, retried until the give-up); empty balance in the check is `ok: false`
      (as `media` does); the tile carries `balance: remaining/limit` and `low` (empty or under 10 %); `activate` returns
      `{ watchOnce }` as a test seam (the host ignores the return value)

### Task 6: Verify acceptance criteria
- [x] verify all requirements from Overview are implemented (three tools, check, tile, watcher, provenance with `image_urls`)
- [x] verify edge cases: empty `originalUrls` and `previewUrls` → reply says no files and settles succeeded with
      `artifacts: []`; `workflow_id` numeric vs visual id both accepted; `inputs` without `prompt` gets a label from `note`
- [x] run `node --check index.mjs` and the full `npm test`
- [x] verify `plugin.yaml` parses as YAML and every `config_schema.properties` key has a default or is optional in `index.mjs`
- ➕ note: the checks live in `test/acceptance.test.mjs` (wiring of the three tools, check, tile and watcher; empty
      outputs through `loremax_generate` and the watcher; numeric and visual ids; label from `note`; the manifest's
      `config_schema` keys all have a default in `createClient`); `plugin.yaml` was also parsed with Ruby's YAML

### Task 7: [Final] Documentation
- [x] write `README.md` like fal's: what it is, install from the catalog, Settings → Integrations → `LOREMAX_API_KEY` /
      `LOREMAX_BASE_URL`, optional `bridex.yaml` config block, tools table (free/paid), output naming and the sidecar's
      `generation` fields, the reboot-proof wait, a short "for the studio" note (default workflows are named in
      `studio/art-guide.md`; references come from `artifacts/studio-references/`)
- [x] add a `CHANGELOG.md` entry for 0.1.0

## Technical Details
- **Request/response shapes** are the verified ones in Decisions; `workflowId` is sent as given (LoreMax accepts numeric ids
  and visual ids).
- **In-memory generation map**: `Map<string, { workflow, inputs, references, tokensCost, trackedId }>` keyed by the LoreMax
  generation id; lost on restart — the watcher then uses `job.model` (workflow) and `job.label` only.
- **File names**: `<workflow slug>` = `workflow_id` lower-cased, non `[a-z0-9]` runs → `-`, trimmed; outputs
  `<slug>-<generationId>.<ext>` or `-<i+1>` suffix when several.
- **Spend**: `usage.record` kind `loremax`, `units = tokensCost`, `unit = "tk"`, `costUsd = tokensCost × usd_per_token`
  (0 when unset — the charts then show tokens only).
- **Wake prompt key**: `loremax-job:<job.id>` dedupes repeats.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- Install on a studio instance from the catalog once the registry entry exists; set `LOREMAX_API_KEY` (an `lmx_prod_…`
  key) and, if not the default, `LOREMAX_BASE_URL`; the plugin check should report the token balance.
- Run `loremax_workflows`, then one cheap workflow through `loremax_generate` with one `artifacts/…` reference; confirm the
  file in the task artifacts, the Source card in the studio (provider LoreMax, workflow, reference thumbnail), and the
  spend chart entry.
- Kill the server mid-wait and confirm the watcher finishes the generation and wakes the agent.

**External system updates**:
- Push this repository to GitHub (`nik-devs/bridex-plugin-loremax`) and add the `loremax` entry with the pinned commit to
  `bridex-plugins/index.yaml` (`permissions: { network: true, llm: false }`).
- Bridex (branch `studio`): plan `20261011-studio-loremax-generation` adds `loremax` to the studio's generation plugins,
  the wiki pages and the art-guide skill.
- bridex-cp: plan `20261011-cp-studio-loremax-env` passes `STUDIO_LOREMAX_API_KEY` / `STUDIO_LOREMAX_BASE_URL` to studio
  instances as `LOREMAX_API_KEY` / `LOREMAX_BASE_URL`.
