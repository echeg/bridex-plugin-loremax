# LoreMax plugin: a workflow routing guide, profile instructions and profile text editing

## Overview
- Bridex's built-in media plugin ships a routing guide (the system-wiki page `media-generation`: which model for
  which task, plus rules of thumb). LoreMax agents get nothing like it: `loremax_workflows` lists titles and
  categories, and a profile tool's default description is only `Generate an image with "<title>"`.
- This plan ports the idea to loremax: a curated guide that ships with the plugin (`guide.mjs`), shown in
  `loremax_workflows` and always intersected with the live catalog, so the agent sees only what it can actually
  run; in profile mode the studio's own profile instructions are read and take precedence; and an opt-in tool lets
  an agent write the profile's description texts back into LoreMax.
- REST mode: `recommended` (best live workflow per task), model-agnostic `rules`, then the full list; details gain
  `guide`. Profile mode: the profile's `instructions`, `recommended` by profile tool names, `rules`, per-tool
  `use_for`; details gain `guide`. New `loremax_profile_edit` (profile mode + `allow_profile_edit: true` only).

## Decisions
- **Context**: plugins cannot add system-wiki pages (the Bridex core loads only its own `server/system-wiki/`;
  `PluginContext` has no manual API), so the guidance has to travel in loremax's tool replies. About 99% of LoreMax
  workflows are shared across organizations and the catalog changes rarely, so a static guide updated with plugin
  releases is enough; a profile holds 1–25 tools curated by a manager, whose texts must win over a generic guide.
- **Chosen approach**:
  - **One guide, both modes.** `guide.mjs` at the plugin root (an ES module, no JSON import):
    `{ rules: [...], workflows: { "<visual_id>" | "id:<n>": { use_for, knobs, caveats } }, routes: [{ task, pick: [keys in priority order] }] }`.
    It is always intersected with the live catalog: an entry whose workflow the organization or the profile lacks is
    never shown; a route with no live pick is dropped. `activate(ctx, { guide })` takes an override so tests do not
    depend on the shipped content.
  - **REST list**: `recommended: [{ task, workflows: [{ id, visual_id, title, why }] }]` FIRST (so `cap()` never cuts
    it), then `rules`, then the existing `workflows`. With `query`: `recommended` filtered by the same query,
    `rules` omitted. **REST details**: `guide: { use_for, knobs, caveats }` when an entry matches. The tool
    description adds "start from recommended; cheap or draft workflows only when asked".
  - **Profile instructions, lazily**: a separate `initialize` request, sent only when the agent reads the
    `loremax_workflows` list, cached for the catalog TTL (10 min) with concurrent callers sharing one request. The
    catalog load, generation, uploads and the health check do not change. LoreMax appends its standard raw-MCP
    operating lines to the manager's text; the plugin drops lines starting with those known prefixes (the plugin
    already does what they describe) and keeps the studio's text. A failed `initialize` gives `instructions: null`
    for that call (not cached); the tools still work.
  - **Profile list**: `instructions`, `recommended` (same builder, matched via `_meta` `visualId` then `workflowId`,
    named by profile tool names), `rules`, `tools` (each with a short `use_for` when matched; the 200-char
    description cut stays), `hint`. **Profile details**: adds `guide` (dropped first when the reply is over the cap;
    the schema is never cut). The hint states the precedence: the studio's instructions and the profile's tool
    descriptions override `guide` and `recommended`. The guide is shown alongside, never instead of, a description.
  - **`loremax_profile_edit`**: registered only in profile mode and only with `allow_profile_edit: true` (new config,
    default false). Edits texts only — the profile `description` and the `tool_description` of tools already bound —
    never bindings, tool names or `is_active`. `apply: false` (default) previews through `PUT …?preview=true` and
    returns `changes: [{ field, before, after }]`; `apply: true` rereads the profile right before the `PUT`, so the
    diff is recomputed against what LoreMax has now. Refuses before writing: an unknown tool name, a text over 2000
    chars, any incompatible workflow, and a text containing `[redacted]` that would be sent back unchanged. After a
    save the catalog and the instructions cache are marked stale.
  - **Catalog export** for maintaining the guide: a read-only script in the private LoreMax repository (outside
    this plan) writes an allowlist of public fields of the workflows available to all organizations to
    `docs/catalog/loremax-workflows.json`. That path is git-ignored here: the export is source material for the guide,
    never committed. Update flow: re-export → compare against `guide.mjs` → update the guide → release.
- **Rejected alternatives**:
  - the guide only in a studio wiki page (`studio/art-guide.md`): every studio writes it by hand, nothing works out
    of the box;
  - the guide only as LoreMax-side workflow descriptions: best long-term, but needs LoreMax changes and a deploy —
    deferred (LoreMax's default tool description already includes the workflow's own description, so it would
    improve profiles later too);
  - the guide in REST mode only: profiles built without manager descriptions would keep the useless default text;
  - replacing an empty profile description with the guide: needs sniffing LoreMax's default-description template;
    alongside + an explicit precedence rule needs no such coupling;
  - lifting the 200-char description cut in the profile list: 25 tools × 2000 chars is too big; the details view
    already shows the whole description;
  - `[initialize, tools/list]` as one batched POST inside the catalog load: saves one rate-limit unit per 10 min but
    changes the request every profile-mode path makes and breaks the profile mocks in 7 test files, for data only
    the list view needs;
  - letting the edit tool change bindings, names or `is_active`: would break other clients of the same profile;
  - registering the edit tool always and refusing when disabled: clutters every agent's tool list;
  - exporting the catalog through the API key, or keeping the export script in this public repository: would
    expose organization-specific workflow names and private infrastructure.
- **Verified facts** (`main` @ fb1be0b):
  - `index.mjs`: `REPLY_CAP` 14 000 (`:30`), `CATALOG_TTL_MS` 10 min (`:73`), config defaults and parsing
    (`:150-215`), `restJson` with `X-API-Key` (`:256`), `rpc()` (single message or batch, `:278`), `profileTool`
    reads `_meta["loremax.ai/workflow"]` → `workflowId, visualId, title, category, contentType, pipeline` (`:413-417`),
    `createProfileCatalog` (`:440`, comment at `:454` still says a profile holds at most 10 workflows),
    `profileList` with `description.slice(0, 200)` (`:516`), `profileDetails` keeps the full description up to
    `REPLY_CAP` and never cuts the schema (`:546`), `activate(ctx, { pollMs, now, sleep })` (`:1119`), `cap()`
    (`:1215`), `short()` (`:1216`), the profile/REST tool swap with the config-error wrapper (`:1224-1227`), profile
    `loremax_workflows` (`:1232`), REST `loremax_workflows` (`:1314`).
  - LoreMax profile management API (organization API key via `X-API-Key` or Bearer; every request costs one unit
    of the key's rate limit): `GET /api/v2/mcp-servers` → `profiles[]` with numeric `id` and `public_id`;
    `GET /api/v2/mcp-servers/<id>` → `{ profile: { name, description, is_active, tools: [{ workflow_id, tool_name,
    position, tool_description }] }, workflows, preview }`; `PUT /api/v2/mcp-servers/<id>` is a strict full
    replacement with body `{ name, description, is_active, tools: [{ workflow_id, tool_name, tool_description }] }`
    (array order = position; unknown keys such as `position` give 400); `?preview=true` returns
    `{ workflows, preview }` without saving; a save with any `compatible: false` workflow is 400 with `workflows`;
    `description` and `tool_description` ≤ 2000 chars; names and descriptions come back with URL query strings
    replaced by `?[redacted]`; another organization's or an unknown id is 404.
  - The profile's `initialize` result carries `instructions` = the manager's profile description, then LoreMax's
    standard rules, joined by `\n`; tools work without `initialize`.
  - Tests: `node --test test/`, `fakeCtx` and `mockFetch` in `test/helpers.mjs`, fixture
    `test/fixtures/profile-tools-list.json` (tools with `_meta` for workflow ids 1, 7, 12; visual ids `null`,
    `masked-edit`, `styled-portrait`); profile endpoint mocks answer a single `tools/list` message in 7 test files;
    `test/workflows.test.mjs:172` asserts the REST description and schema are 0.1.0's.

## Context (from discovery)
- Files/components involved: `index.mjs` (REST and profile `loremax_workflows`, `profileList`, `profileDetails`,
  `createProfileCatalog`, config parsing, tool registration), new `guide.mjs`, `plugin.yaml` (config schema,
  version), `package.json` (version), `.gitignore` (new), `README.md`, `CHANGELOG.md`, `test/workflows.test.mjs`,
  new `test/guide.test.mjs`, new `test/profile-edit.test.mjs`.
- Related patterns found: injectable seams through `activate(ctx, { … })`; one shared in-flight promise for
  concurrent readers (`createProfileCatalog.get`); 50 s budget per tool call via `deadline`; structured errors
  through `httpError` / `deadlineError`; replies as indented JSON through `text(cap(...))`.
- Dependencies identified: none new.

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
- Run tests after each change (`npm test`)
- Maintain backward compatibility: generation, uploads, results, the watcher and the health check behave as before

## Testing Strategy
- **Unit tests**: required for every task (see Development Approach above); `node --test` with `fakeCtx` and
  `mockFetch`, no network
- **E2E tests**: none in this project

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests, the guide content, documentation in this repository
- **Post-Completion** (no checkboxes): producing the catalog export, manual checks against a real LoreMax

## Implementation Steps

### Task 1: The guide module and its matching helpers
- [x] create `guide.mjs` exporting `GUIDE = { rules, workflows, routes }` with the model-agnostic `rules` from
  Technical Details and empty `workflows` / `routes` (filled in Task 7); a header comment states the format, the
  key rule (`visual_id`, else `id:<n>`) and the update flow
- [x] add `.gitignore` with `docs/catalog/` (the catalog export is never committed)
- [x] add pure helpers in `index.mjs`: `guideKey({ visualId, workflowId })`, `guideEntry(guide, identity)` (by
  visual id, then `id:<n>`), and `recommendedFrom(guide, items, query)` that maps routes to the live items they
  pick (in `pick` order, routes with no live pick dropped, an optional query over task, title, visual id and
  category)
- [x] let `activate(ctx, { guide })` override the shipped guide (default `GUIDE`)
- [x] create `test/guide.test.mjs`: shipped-guide integrity (every `routes[].pick` key exists in `workflows`; every
  entry has a non-empty `use_for`; every key is a non-empty visual id or `id:<n>`; when the export file exists at
  `$LOREMAX_CATALOG_EXPORT` or `docs/catalog/loremax-workflows.json`, every key exists in it — skipped otherwise)
- [x] write tests for the helpers: key fallback, visual id beats numeric id, dead picks and dead routes dropped,
  pick order kept, query filtering (by task and by item), an empty guide gives `[]`
- [x] run tests - must pass before task 2

### Task 2: REST mode — `recommended`, `rules` and `guide` in `loremax_workflows`
- [x] list (no `workflow_id`): reply `{ recommended, rules, workflows, hint }` with `recommended` first; items
  `{ id, visual_id, title, why }` where `why` is the entry's `use_for`; omit `recommended` when it is empty
- [x] with `query`: `recommended` filtered by the same query, `rules` omitted
- [x] details (`workflow_id`): add `guide: { use_for, knobs, caveats }` when an entry matches the workflow's
  visual id or id (the id may be given as either)
- [x] extend the REST tool description with: start from `recommended`, the best live workflow per task; cheap or
  draft workflows only when asked
- [x] update `test/workflows.test.mjs:172` (the description is no longer 0.1.0's; the schema and calls still are)
- [x] write tests: recommended only with live workflows, dead route dropped, `recommended` and `rules` survive
  `cap()` with a huge list, query filters `recommended` and drops `rules`, details carry `guide` (matched by
  visual id and by numeric id), no `guide` key when unmatched, an empty guide changes nothing but `rules`
- [x] run tests - must pass before task 3

### Task 3: Profile mode — the profile's instructions, read lazily
- [x] add `createProfileInstructions(lmx, { now })` next to `createProfileCatalog`: `get({ deadline })` sends one
  `initialize` (`protocolVersion` `2025-06-18`, `clientInfo` `bridex-plugin-loremax` + version) to the profile path,
  caches the cleaned text for `CATALOG_TTL_MS`, shares one in-flight request, and has `invalidate()`
- [x] clean the text: drop lines that start with LoreMax's standard rule prefixes (Technical Details), trim, empty
  → `null`
- [x] a failed or malformed `initialize` (HTTP error including 404, JSON-RPC error, timeout, no `instructions`)
  returns `null` for this call and is not cached; a dead profile is still reported by the catalog read, as today
- [x] write tests: one `initialize` per TTL, concurrent callers share it, standard lines stripped and the studio's
  lines kept in order, only-standard text → `null`, failure → `null` and retried next call, `invalidate()` forces a
  reread, the catalog load and generation send no `initialize`
- [x] ➕ `PLUGIN_VERSION` constant in `index.mjs` for `clientInfo` (a test keeps it equal to `package.json`; bump it with the version in Task 9)
- [x] run tests - must pass before task 4

### Task 4: Profile mode — `instructions`, `recommended`, `use_for` and `guide` in `loremax_workflows`
- [x] profile list: reply `{ instructions, recommended, rules, tools, hint }`; `recommended` built by
  `recommendedFrom` over the profile's generation tools (identity from `_meta`), items `{ tool, title, why }`;
  each `tools[]` row gets `use_for` when matched; the 200-char description cut stays
- [x] the hint states the precedence: the studio's instructions and the tools' own descriptions override `guide`
  and `recommended`; with `query`, `rules` omitted and `recommended` filtered as in REST mode
- [x] profile details: add `guide` when matched; in `profileDetails`, the over-cap path drops `guide` before
  shrinking the description (the schema is never cut)
- [x] fix the `:454` comment (a profile holds up to 25 tools)
- [x] ➕ wire `createProfileInstructions` into `activate` (Task 3 only defined it); the list reads the catalog and the instructions in parallel
- [x] ➕ `recommendedFrom`'s query also matches a profile item's tool name, like the profile list's own filter
- [x] write tests (with the fixture's `masked-edit` / `styled-portrait` / `id:1` identities and an injected guide):
  list carries instructions, recommended by tool names, `use_for`, the precedence hint; a tool without `_meta` gets
  no `use_for`; details carry `guide`; an over-cap schema drops `guide` and keeps the schema whole; `initialize`
  failure → `instructions: null` with the list intact
- [x] run tests - must pass before task 5

### Task 5: `allow_profile_edit` and the profile's management id
- [x] add `allow_profile_edit` (boolean, default false, title and description saying it lets agents rewrite the
  profile's texts in LoreMax for every client of the profile) to `plugin.yaml` `config_schema` and to config
  parsing (`true` only for a literal `true`)
- [x] register `loremax_profile_edit` only when profile mode AND `allow_profile_edit` (through the existing
  `registerTool` wrapper, so an invalid `profile_url` makes it throw the config error)
- [x] add `profileManagementId({ deadline })`: `GET /api/v2/mcp-servers`, match `public_id` to the profile's
  publicId, cache the numeric id in memory; not found → an error naming the publicId and the three causes
  (unknown, disabled or deleted, another organization)
- [x] write tests: not registered in REST mode, not registered without the flag, registered with it; the flag
  rejects `"true"` strings and other values; id lookup cached across calls; no match → the named error; a 3xx
  refused like every other request
- [x] ➕ until Task 6, `loremax_profile_edit`'s handler only resolves the management id (`{ profile_id }`, read-only)
- [x] run tests - must pass before task 6

### Task 6: `loremax_profile_edit` — preview and apply
- [ ] args: `instructions?: string | null` (profile description; omitted = unchanged; `null` or `""` clears),
  `tools?: [{ tool, description: string | null }]` (by current tool name), `apply?: boolean` (default false); the
  tool description says it changes what every client of the profile sees and that a preview comes first
- [ ] validate before any request: at least one change requested, each text ≤ 2000 chars; after the `GET`, every
  `tool` names a bound tool (an unknown name lists the bound ones)
- [ ] build the strict `PUT` body from `GET /api/v2/mcp-servers/<id>`: `{ name, description, is_active, tools:
  [{ workflow_id, tool_name, tool_description }] }` in position order, only the requested texts changed; refuse when
  any field that would be sent unchanged contains `[redacted]` (name the field; tell the agent a person must fix it
  in LoreMax → Organization → MCP); no changes → "nothing to change", no `PUT`
- [ ] `apply: false`: `PUT …?preview=true`, return `{ applied: false, changes, incompatible, hint: "call again with
  apply: true to save" }`; `incompatible` lists workflows with `compatible: false` (refuse to suggest applying when
  non-empty)
- [ ] `apply: true`: a fresh `GET` right before the `PUT` (diff recomputed against it), `PUT` without preview; a
  400 surfaces LoreMax's `issues` / incompatible `workflows`; on success return `{ applied: true, changes }` and mark
  the catalog stale and `invalidate()` the instructions; the whole call stays within the 50 s budget
- [ ] write tests: preview sends `?preview=true` and the strict body (no `position`, bindings and `is_active`
  unchanged, order kept); apply does a fresh GET and keeps a description changed in LoreMax between preview and
  apply; refusals (no change requested, > 2000 chars, unknown tool, unchanged `[redacted]`, incompatible workflow)
  send no `PUT`; clearing with `null` and `""`; 400 and 404 errors; the catalog and instructions are reread after a
  save
- [ ] run tests - must pass before task 7

### Task 7: Fill the guide from the catalog export
- [ ] read the export from `$LOREMAX_CATALOG_EXPORT`, else `docs/catalog/loremax-workflows.json`; if neither
  exists, mark this task ⚠️ blocked ("catalog export missing — see Post-Completion") and stop: never invent
  workflows
- [ ] fill `GUIDE.workflows` for the workflows worth recommending: `use_for` (one line), `knobs` (the inputs that
  matter), `caveats` (what goes wrong); keys are visual ids, else `id:<n>`
- [ ] fill `GUIDE.routes` for the tasks in Technical Details, each with picks in priority order, best first;
  cheap or draft workflows are never the first pick
- [ ] carry the media-generation caveats over to the matching workflows (e.g. a real-looking face refused as a
  frame or reference by some video models; no transparent background on cheap image models)
- [ ] no organization-specific names, provider URLs, prices or internal settings in `guide.mjs` (public repository)
- [ ] run tests (the integrity test now checks every key against the export) - must pass before task 8

### Task 8: Verify acceptance criteria
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled (empty guide, no live picks, `initialize` failure, invalid `profile_url` with
  the flag on, edit refusals)
- [ ] run full test suite (`npm test`)
- [ ] verify generation, uploads, results, the watcher and the health check make the same requests as before
  (no `initialize`, no `/api/v2/mcp-servers`)

### Task 9: [Final] Update documentation
- [ ] `README.md`: the guide (what the agent sees in each mode, the precedence rule, how to update it from an
  export), profile size 1–25, "three tools plus an optional fourth", `allow_profile_edit` and
  `loremax_profile_edit` (texts only, preview → apply, the refusals, the concurrent-edit caveat), the config block
- [ ] `CHANGELOG.md`: 0.3.0 entry; bump `version` in `plugin.yaml`, `package.json` and `PLUGIN_VERSION` in `index.mjs` to 0.3.0
- [ ] `index.mjs` header comment: the guide and the edit tool

## Technical Details
- **Guide format** (`guide.mjs`):
  ```js
  export const GUIDE = {
    rules: ["…"],
    workflows: { "styled-portrait": { use_for: "…", knobs: "…", caveats: "…" } }, // key: visual_id, else "id:<n>"
    routes: [{ task: "game asset / sprite (transparent)", pick: ["…", "…"] }],
  };
  ```
- **Model-agnostic rules** (Task 1), adapted from `media-generation`:
  1. Read a workflow's inputs (or a profile tool's schema) before every paid call.
  2. A character that must stay the same across images: make ONE base card at top quality, then vary it through
     references — never regenerate the character from a prompt each time.
  3. Aspect ratio follows the placement: 9:16 for stories/reels, 1:1 for avatars and grids, 16:9 for covers; set it
     explicitly, defaults differ per workflow.
  4. Game assets (a sprite, a part, an icon): a transparent background where the workflow offers one, not a flat
     backdrop to cut out later.
  5. Text inside the picture: only workflows whose guide says they render text.
  6. Preview at the cheapest duration/resolution, then commit the real settings with the same seed where the
     workflow takes one.
  7. Video is generated, not assembled: one take per scene, never a chain of short stubs glued together.
  8. Look at what you made before handing it over (watch a clip with `video_understand`).
  9. Cheap or draft workflows only when someone asked for cheap or draft.
- **Routes** (Task 7): game asset with transparency; key art / illustration; text inside the image; base
  character card; outfit / pose variations of a character; photoreal product / lifestyle; logo / icon as vector;
  stylised concept art; image edit / inpaint; upscale; video from a reference or first frame (one take); video with
  faces; motion-heavy video; audio / music / voice; 3D model; text. A route with no suitable workflow in the export
  is left out.
- **LoreMax standard instruction lines dropped** (Task 3), matched as line prefixes:
  `Each workflow tool call starts one paid generation`, `Use tools/list for current schemas`,
  `Poll check_generation`, `Do not automatically resubmit`, `on_behalf_of is a display-only`,
  `An api_key argument must belong`, `Media arguments take finalized organization URLs`.
- **Reply shapes**:
  - REST list: `{ recommended?: [{ task, workflows: [{ id, visual_id, title, why }] }], rules?, workflows, hint }`
  - REST details: `{ workflow, input_fields, usage_hint, guide?, token_cost | price, … }`
  - profile list: `{ instructions: string | null, recommended?: [{ task, tools: [{ tool, title, why }] }], rules?,
    tools: [{ tool, title, category, description, use_for?, required, file_args }], hint }`
  - profile details: `{ tool, title, description, guide?, schema, file_args, limits, how_to_call }`
  - edit: `{ applied, changes: [{ field: "description" | "tool:<name>", before, after }], incompatible?, hint }`
- **Edit flow**: `profileManagementId` (cached) → `GET /<id>` → validate + build body → preview `PUT ?preview=true`
  or (apply) fresh `GET` → `PUT` → catalog stale + instructions invalidated. Residual risk: LoreMax has no ETag, so
  a manager's edit landing between the fresh `GET` and the `PUT` can be lost; documented in the README.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Before Task 7 runs**:
- Produce the catalog export with the read-only script in the private LoreMax repository (public fields of the
  workflows available to all organizations only) and place it at `docs/catalog/loremax-workflows.json` in the
  checkout loopai works in — for a worktree run that is the worktree, not the main checkout — or set
  `LOREMAX_CATALOG_EXPORT` to its absolute path.

**Manual verification**:
- On a studio instance in profile mode: the list shows the profile's instructions and `recommended` by tool names;
  with `allow_profile_edit` on, a preview and an apply change a tool description that LoreMax's
  Organization → MCP page then shows.
- In REST mode against a real organization: `recommended` lists only workflows the organization has.

**Later (not in this plan)**:
- Write good global workflow descriptions in LoreMax itself; LoreMax's default profile tool description includes
  them, so profiles without manager texts improve for every client, not only Bridex.
