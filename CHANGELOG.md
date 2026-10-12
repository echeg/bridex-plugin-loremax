# Changelog

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
