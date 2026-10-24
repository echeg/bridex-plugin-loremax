# Changelog

## 0.3.0 — 2026-10-24

A routing guide in `loremax_workflows`, the studio's profile instructions, and an opt-in tool that edits the profile's
texts.

- **Routing guide**: `guide.mjs` ships with the plugin — model-agnostic `rules`, per-workflow `use_for` / `knobs` /
  `caveats`, and `routes` (tasks with their workflows, best first). It is always intersected with the live catalog,
  so an agent never sees a workflow its organization or profile lacks. REST `loremax_workflows` lists `recommended`
  (the best live workflows per task) and `rules` before the workflows, and a workflow's details carry `guide`. With a
  `query`, `recommended` is filtered by it and `rules` is left out. The shipped guide carries only the `rules` for
  now: its workflows and routes are filled from a catalog export (see README → The routing guide).
- **Profile instructions**: in profile mode the list carries `instructions` — the profile's description, read through
  `initialize` only when the agent lists the tools, cached for 10 minutes, with LoreMax's standard operating lines
  dropped; `null` when `initialize` fails, with the list intact. The list also carries `recommended` by profile tool
  names, `rules` and a per-tool `use_for`; a tool's details carry `guide`, dropped first when the reply is over its
  cap (the schema is still never cut). The studio's instructions and the tools' own descriptions take precedence over
  the guide, and the hint says so.
- **`loremax_profile_edit`**: with the new `allow_profile_edit` config (default `false`), profile mode registers a
  fourth tool that rewrites the profile's description and its bound tools' descriptions in LoreMax — for every
  client of the profile — never bindings, tool names or activation. `apply: false` (default) previews through
  LoreMax and returns `changes: [{ field, before, after }]`; `apply: true` rereads the profile and saves. It refuses,
  before saving, an unknown tool name, a text over 2000 characters, any text sent with `[redacted]` in it (unchanged,
  or copied into a new text) and a profile with incompatible workflows. An unchanged text holding a URL, which
  LoreMax reads without its `#fragment` and `user:pass@`, is named in a `warning`. After a save the tool list and the
  instructions are reread.
- Generation, uploads, results, the watcher and the health check make the same requests as in 0.2.1.

Upgrading from 0.2.1: nothing to change. Agent prompts may start from `recommended`; set `allow_profile_edit: true`
only where agents should be able to rewrite the profile's texts for all its clients.

## 0.2.1 — 2026-10-15

Fixes for three findings from the review of the catalog PR (nik-devs/bridex-plugins#1): a double charge, the key
leaving LoreMax on a redirect, and a watcher that spent the organization's rate limit on polling.

- **No double charge**: a `loremax_generate` call identical to one still being submitted (same workflow or profile
  tool, same inputs or arguments, same reference files by content and order, same base URL, profile and API key, same
  caller — workspace, agent, session and task) is refused before any request:
  `status: "submitting"` with `duplicate_of` naming the running submission and the "do NOT call again" hint. The
  request is free again once LoreMax accepts or refuses the first one. Works on cores without `ctx.jobs` too.
- **The key stays on LoreMax**: API requests (REST and `/api/mcp`) no longer follow redirects — a 3xx is refused
  with "redirected — refused, the key must not leave <host>" instead of resending `X-API-Key` to the new host. On the
  paid request it is reported as "may have been charged": LoreMax may have accepted the call before redirecting.
  `base_url` / `LOREMAX_BASE_URL` and `profile_url` accept `https://` only; an `http://` value is a config error that
  names the setting, raised on the plugin card at activation. The health check reports both with their own message.
- **A quiet watcher**: a pending generation is checked every 15 s while under 2 min old, every 60 s until 30 min,
  every 5 min after that (the 6 h give-up stays), so long generations no longer eat LoreMax's 1000 requests an hour
  and push paid calls into 429. A failed check keeps the schedule. One watcher runs per process: a re-activation
  (settings save, update, dashboard toggle) stops the previous one instead of starting a second, and takes its in-memory
  jobs over, with or without a shutdown in between.

Upgrading from 0.2.0: a `base_url` or `profile_url` starting with `http://` must be changed to `https://`.

## 0.2.0 — 2026-10-12

Profile mode, and fixes for tool calls that outlived the agent's MCP client.

- **Profile mode**: with the new `profile_url` config (a LoreMax MCP profile URL from Organization → MCP, or its bare
  publicId), the three tools use the profile as catalog and execution channel. `loremax_workflows` lists only the
  curated workflows and returns a tool's exact JSON Schema (never truncated), its file arguments and media limits;
  `loremax_generate {tool, arguments}` injects `schema_revision` and `on_behalf_of` (`bridex:<workspace>:<agent>`).
  An invalid `profile_url` is a config error; the plugin never falls back to the whole organization catalog.
- Profile file arguments take workspace paths: checked against the tool's `x-loremax-media` / `x-loremax-limits`
  before any HTTP, uploaded through `request_upload_url → PUT → finalize_upload` (deduped within a call, finalized
  URLs reused for an hour), and nothing is charged when an upload fails.
- Profile errors map to `status: "rejected"` (not charged: invalid input or media, schema changed — with the fresh
  schema, tool unavailable — with the current list) or `status: "failed"` (insufficient tokens, generation failed);
  a 404 profile names its three causes.
- Health check and balance tile read the balance through the profile; the check reports "profile reachable, N tools".
- **Wait budget**: `default_wait_s` is now 45 (was 180) and every `wait_s` is capped at 50 s (was 1500), below the
  60 s MCP client timeout of Bridex agents. The budget covers the whole call — lookup, uploads, submission, polling,
  Retry-After sleeps and downloads.
- A paid submission that LoreMax has not answered by the deadline replies `status: "submitting"` and goes on in the
  background; the agent is woken with the result. It is tracked as a `submit:<uuid>` row, so a restart mid-submission
  wakes the agent once ("may have been charged"). A completed generation whose save would run past the deadline is
  saved in the background and woken. Older cores without `ctx.jobs` / `ctx.wakeAgent` block as in 0.1.0.
- Spend is recorded with `ref` = the generation id, so a repeated finish after a crash is counted once.
- `/api/mcp` calls retry a 429 once, like REST calls, and keep LoreMax's `errorCode` / `details`.
- Text workflows: the text is saved as `<slug>-<generationId>.md` with provenance instead of "no files".
- Audio (mp3, wav, m4a, ogg, flac, aac), more video (mkv, ts, m4v) and 3D (glb, gltf, obj, stl, usdz, fbx) outputs get
  their real extension instead of `.bin`.

Upgrading from 0.1.0:

- `default_wait_s` values above 50 in `bridex.yaml` are capped at 50; lower them to match the schema.
- Agent prompts that handle `loremax_generate` replies should treat `status: "submitting"` as "end the turn, do not
  call again": the agent is woken with the outcome.

## 0.1.0 — 2026-10-11

First release.

- `loremax_workflows`: the organization's workflows with a text filter; one workflow's input fields, usage hint and
  price in tokens.
- `loremax_generate`: runs a workflow with inputs passed through unchanged and up to 20 workspace references (≤ 20 MB
  each) sent as files; waits, then saves the outputs into the task's artifacts with a `generation` provenance block
  (`provider`, `workflow`, `params` with `image_urls`, `externalId`) and records the token spend under kind `loremax`.
- `loremax_result`: status / result of a generation that outlived the wait.
- Reboot-proof watcher: pending generations are finished after a restart and the agent is woken in its session;
  a generation pending for over 6 h is given up.
- Health check (key and balance), a dashboard balance tile, an out-of-funds inbox card on 402.
- Config: `api_key` / `base_url` from the managed `LOREMAX_API_KEY` / `LOREMAX_BASE_URL` credentials (both
  required), `default_wait_s` (180), optional `usd_per_token`.
