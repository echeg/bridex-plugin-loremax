# LoreMax plugin: no double charge, no key on redirects, a quiet watcher

## Overview
- Three findings from the nik-devs review of the registry PR, the ones that cost money or a key on the user's own
  cloud: (1) the same generation can be submitted twice while the first submission is still landing — two paid
  runs; (2) every pending generation is polled every 15 s for up to 6 h and a re-activation (settings save,
  update, dashboard toggle) starts a second watcher next to the first — the organization's 1000 req/h limit goes
  to polling and paid calls get 429; (3) API requests follow redirects with `X-API-Key` attached and `base_url`
  accepts `http://`.
- Out of scope, deferred to later plans: SSRF guard on result/upload URLs and `min_bridex` + registry PR text
  (needed for the public catalog), streaming downloads to disk (memory).

## Decisions
- **Context**: review of nik-devs/bridex-plugins#1 on 2026-10-15; the user ranked the findings: these three now,
  catalog-only ones later, memory into the backlog.
- **Chosen approach**:
  - duplicate submission → the second call is refused with a `status: "submitting"`-style reply that names the
    running one (no second paid call); key = sha256 of `mode + workflow/tool + canonical JSON of the agent's
    arguments/inputs + sorted reference file hashes + workspace`, held from `trackSubmit` until `settleSubmit`
    (success or failure) in a process-wide map next to `inFlight`;
  - watcher cadence → per-job next-check time with a growing interval: 15 s while a job is under 2 min old,
    60 s under 30 min, 5 min after that (the 6 h give-up stays); the `setInterval` tick stays 15 s but skips jobs
    whose next-check is in the future; the handle lives in `globalThis[Symbol.for("bridex.loremax.watcher")]`
    and a new activation clears the previous one before starting its own;
  - redirects → `send()` passes `redirect: "error"`; `baseUrl()` and `profilePath()` accept only `https://`
    (a `http://` value is a config error naming the setting). Result downloads (`:700`) and the upload PUT
    (`:921`) keep `follow` for now — that is the SSRF task of the next plan.
- **Rejected alternatives**: attaching a duplicate call to the running submission (await the same promise and
  return its result) — more code for an agent error the hint already forbids; batching `/check` calls — the
  LoreMax check endpoint takes one id; a per-activation watcher with `ctx.onShutdown` only — the host does not
  always call it on re-activation, which is exactly the finding.
- **Verified facts** (`main` @ 7d73065): `inFlight` is a process-wide `Set` keyed by `submit:<uuid>` and
  generation ids (`index.mjs:1124,1545,1593`), so it never matches two identical requests; `trackSubmit` is
  called from the profile tool (`:1220`) and the REST tool (`:1736`); `send()` (`:210-236`) calls `fetch` without
  a `redirect` option, `restJson` (`:240`) and the MCP call (`:264`) go through it with `X-API-Key`; `baseUrl()`
  (`:161-166`) accepts `https?://`; the watcher is `setInterval(watchOnce, WATCH_MS=15_000)` (`:2000`) cleared
  only in `ctx.onShutdown`; `watchOnce` calls `statusOf(job)` → `lmx.check` once per pending row per tick
  (`:1946`); tests run with `node --test test/` on `mockFetch` routes from `test/helpers.mjs`, the watcher is
  driven by `activate(ctx, { pollMs, now })` and `seam.watchOnce()` (`test/result-watcher.test.mjs:19-24`).

## Context (from discovery)
- Files/components involved: `index.mjs` (`send`, `baseUrl`, `profilePath`, `trackSubmit`/`settleSubmit`, both
  generate handlers, `watchOnce` and the watcher start), `test/generate.test.mjs`, `test/http.test.mjs`,
  `test/config.test.mjs`, `test/result-watcher.test.mjs`, `README.md`, `CHANGELOG.md`, `plugin.yaml` (version).
- Related patterns found: process-wide state through `globalThis[Symbol.for(...)]` (`inFlight`); injectable
  `now`/`sleep` for time in tests; `httpError`/`deadlineError` helpers for structured errors.
- Dependencies identified: none new (`node:crypto` for the hash is already imported).

## Development Approach
- **Testing approach**: TDD (tests first)
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
- Maintain backward compatibility: replies, tool names and config keys stay; only a `http://` base_url, which
  never worked against the real LoreMax, is newly refused

## Testing Strategy
- **Unit tests**: `node --test test/` with `mockFetch` routes; a redirecting route (302 + Location) for the
  redirect cases; `fakeCtx` + `activate(ctx, { now })` for the watcher cadence with a controlled clock.
- **E2E tests**: none in this repo.

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

## Implementation Steps

### Task 1: API requests never follow a redirect, base_url and profile_url are https only
- [x] write failing tests in `test/http.test.mjs`: a `mockFetch` route answering 302 with `Location` on another
      host makes `restJson` and the MCP call throw an error naming the redirect, and the second host receives no
      request (no `X-API-Key` anywhere but `base_url`); with `redirect: "error"` asserted on the fetch init
- [x] write failing tests in `test/config.test.mjs`: `base_url: http://…` and `LOREMAX_BASE_URL=http://…` throw
      a config error that names the setting and says https; `profile_url: http://…` likewise; `https://` values
      pass as before
- [x] `index.mjs` `send()`: `fetch(url, { ...init, redirect: "error", signal })`; map the resulting `TypeError`
      to `httpError("loremax <label>: redirected — refused, the key must not leave <base host>", 0, "")`
- [x] `index.mjs` `baseUrl()` / `profilePath()`: accept `https://` only, error text names `LOREMAX_BASE_URL` /
      `plugins.loremax.config.base_url` (or `profile_url`)
- [x] ➕ health check: a redirect (status 0) or a config error (http:// base_url) is reported with its own message,
      not as "LoreMax refused the key (0)" (`test/health.test.mjs`); `mockFetch` emulates Node's fetch on a 3xx
      (`redirect: "error"` throws its TypeError, the default follows with the same headers)
- [x] run `node --test test/` - must pass before task 2

### Task 2: an identical submission in flight is refused, not charged twice
- [x] write failing tests in `test/generate.test.mjs` (REST and profile mode): with a `mockFetch` execute route
      that resolves only when the test releases it, two concurrent `loremax_generate` calls with the same
      workflow/tool, arguments and workspace make exactly one execute request; the second call returns
      `status: "submitting"` with `duplicate_of` (the running submission's id) and the hint; after the first
      settles (success or failure) the same request submits again; different arguments, a different workspace
      or a different reference file submit independently
- [x] `index.mjs`: `submitKey({ mode, workflow|tool, args|inputs, refs, workspace })` = sha256 of canonical
      JSON (sorted keys; reference files by their sha256 from the upload step, sorted); a process-wide
      `Map<key, submitId>` under `Symbol.for("bridex.loremax.submitting")`
- [x] `trackSubmit` records the key (`settleSubmit` and the late-settle paths delete it in `finally`); both
      generate handlers look the key up before `trackSubmit` and return the duplicate reply when it is held;
      cores without `ctx.jobs` (no placeholder row) still use the map so the guard does not depend on the core
- [x] write a test that a failed submission (execute rejects) frees the key immediately
- [x] ➕ profile mode hashes the reference files before `trackSubmit` (the upload step runs after it): every
      string argument that resolves to a workspace file counts; a late failure after `submitting` frees the key too
- [x] run `node --test test/` - must pass before task 3

### Task 3: one watcher per process, polling that slows down with a job's age
- [x] write failing tests in `test/result-watcher.test.mjs`: with a controlled `now`, a pending generation is
      checked at most once per 15 s in its first 2 min, once per 60 s until 30 min, once per 5 min after that
      (count `/check` requests over a simulated hour with `watchOnce` called every tick); a completed check
      still saves and wakes as today; a `/check` error keeps the next-check schedule (no tight retry)
- [x] write a failing test: calling `activate` twice on the same process leaves one interval running (the
      first is cleared; assert through a counting fake `setInterval`/`clearInterval` passed in the seam, or the
      process-wide handle slot)
- [x] `index.mjs`: `nextCheckAt` map (process-wide, keyed by generation id, dropped on settle/give-up);
      `watchOnce` skips a row whose `nextCheckAt > now()` and schedules the next check after each `/check`
      from the row's age: `≤2 min → 15 s`, `≤30 min → 60 s`, else `5 min`
- [x] `index.mjs` watcher start: handle stored in `globalThis[Symbol.for("bridex.loremax.watcher")]`;
      a new activation clears the stored one first; `ctx.onShutdown` still clears it
- [x] ➕ the schedule counts from the pass's start time, not from each `/check`: a row checked late in a slow
      pass is still due on the tick its cadence lands on (else 15 s would become 30 s)
- [x] ⚠️ deviation: `nextCheck` is per activation, not process-wide — only one watcher runs, a fresh activation
      checking every pending job once is harmless, and a process-wide map keyed by generation id leaked a
      schedule from one test's `fakeCtx` into the next (same ids); entries are pruned each pass for rows no
      longer pending (settled by a tool call or the watcher)
- [x] run `node --test test/` - must pass before task 4

### Task 4: Verify acceptance criteria
- [x] verify the three findings are closed: redirect test, duplicate test, cadence test all green and each one
      was seen failing first (TDD)
- [x] verify a `http://` base_url that is the LoreMax default never appears in docs/examples (grep) — only
      refusal tests and this plan mention http://
- [x] run full test suite `node --test test/` (240 pass, 0 fail)
- [x] run the linter if the repo defines one (none today: skipped)

### Task 5: [Final] Update documentation
- [x] `README.md`: https-only base_url/profile_url, the duplicate-submission reply (`duplicate_of`), the watcher
      cadence (15 s / 60 s / 5 min, 6 h give-up) and why
- [x] `CHANGELOG.md` + `plugin.yaml` version `0.2.1`, with the three review findings referenced
- [x] `plugin.yaml` description of `base_url`: "default https://loremax.ai (https only)"
- [x] ➕ `package.json` version `0.2.1` too, so it matches `plugin.yaml`

## Technical Details
- Submit key: `sha256(JSON.stringify({ mode, workflow: workflow ?? tool, args: canonical(agentArgs|inputs),
  refs: sortedRefHashes, workspace }))`, hex. Canonical JSON = keys sorted recursively, arrays as given.
- Duplicate reply (both modes): `{ status: "submitting", duplicate_of: "<submitId or generation id>", workflow|tool,
  hint: "this exact request is already being submitted — do NOT call again; end your turn, you will be WOKEN" }`.
- Watcher schedule: `cadenceMs(ageMs) = ageMs <= 120_000 ? 15_000 : ageMs <= 1_800_000 ? 60_000 : 300_000`;
  `nextCheckAt.set(id, now() + cadenceMs(now() - createdAt))` after every `/check`, including a failed one.
- Watcher handle slot: `globalThis[Symbol.for("bridex.loremax.watcher")] = { interval }`; `activate` does
  `clearInterval(prev?.interval)` before `setInterval`.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

- Pin the new commit in `echeg/bridex-plugins` `index.yaml` (`loremax 0.2.1`) and push; the studio instance
  updates from the catalog (Settings → Plugins).
- Next plan for the public catalog: SSRF guard on result/upload URLs (https only, resolve and refuse loopback,
  private and link-local ranges on every redirect hop), `min_bridex: 0.1.852` in the registry entry, new PR
  title/body in nik-devs/bridex-plugins#1.
- Backlog: streaming downloads to a file (memory), relevant once instances share a packed host.
