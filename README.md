# bridex-plugin-loremax

[LoreMax](https://loremax.ai) image, video, audio, 3D and text generation for
Bridex agents, through the organization's own workflows. An agent lists the
workflows, reads one workflow's inputs (free), runs it with reference files
taken from its workspace, and gets the outputs saved into its task's artifacts
with provenance and token spend.

The plugin works in one of two modes, chosen by `profile_url`:

- **REST mode** (`profile_url` empty): the agent sees every workflow of the
  organization, reads a workflow's input fields and price, and passes inputs
  through unchanged.
- **Profile mode** (`profile_url` set): the agent sees only the workflows a
  LoreMax manager curated into an MCP profile, each with an exact typed
  argument schema, and LoreMax validates the arguments before it charges.

In both modes the workflow list comes with a routing guide — which workflow for
which task, plus rules of thumb — limited to the workflows the agent can
actually run (see [The routing guide](#the-routing-guide)).

## Requirements

Node ≥ 20 (built-in `fetch`, `FormData`, `Blob`, `node:test`; no dependencies).
Job tracking, the reboot-proof watcher, detached submissions and the agent
wake-up need a Bridex core with `ctx.jobs` / `ctx.wakeAgent`; the out-of-funds
card needs `ctx.billing` and the balance tile `ctx.registerStat`. On older
cores the plugin still loads: a submission blocks until LoreMax answers, a
generation that outlives the wait is polled with `loremax_result` (until a
restart: the generation ids live in memory there), and there is no card or tile.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog, or the operator
MCP `plugin_admin install loremax`), then set the credentials:

- **Settings → Integrations → LoreMax key** (`LOREMAX_API_KEY`, format
  `lmx_prod_…`, created in LoreMax under API keys). Read per call — no restart
  needed.
- **Settings → Integrations → LoreMax address** (`LOREMAX_BASE_URL`) — usually
  `https://loremax.ai`; the control plane sets it on studio instances.

Both are `requires_env`: the host does not start the plugin until both are set,
and the plugin card shows `needs env: …` until then. Set `LOREMAX_BASE_URL` to
`https://loremax.ai` even when LoreMax is at its default address.

`base_url` and `profile_url` are **https only**: an `http://` value is a config
error naming the setting (raised on the plugin card at activation, and by every
tool call), because the key travels in every request. API requests
never follow a redirect either — a 3xx from LoreMax is refused ("redirected —
refused, the key must not leave <host>"), so `X-API-Key` reaches no host but
`base_url`'s.

Optional `bridex.yaml`:

```yaml
plugins:
  loremax:
    config:
      api_key: ${LOREMAX_API_KEY}     # default
      base_url: ${LOREMAX_BASE_URL}   # default; https:// only
      default_wait_s: 45              # how long loremax_generate waits before handing back (10..50; empty or invalid = 45)
      usd_per_token: 0.001            # optional: tokens → USD for the spend charts; absent = tokens only
      profile_url: https://loremax.ai/api/mcp/s/AbCdEfGh12345678   # optional: profile mode (or the bare publicId)
      allow_profile_edit: false       # optional, profile mode only: agents get loremax_profile_edit (default false)
```

## Profile mode

A LoreMax **MCP profile** is a named set of 1–25 published workflows of one
organization, curated by a LoreMax manager. LoreMax serves it as an MCP endpoint
at `https://<LoreMax>/api/mcp/s/<publicId>`, where every workflow is a tool with
an exact JSON Schema for its arguments: types, bounds, defaults, required
fields, conditional rules (`x-loremax-conditions`) and file arguments
(`x-loremax-media`).

To use one:

1. In LoreMax, open **Organization → MCP** (`/organization/mcp`), create a
   profile, add the workflows the studio should use, and copy its URL.
2. Put the URL — or just its 16-character publicId — into `profile_url`:

   ```yaml
   plugins:
     loremax:
       config:
         profile_url: https://loremax.ai/api/mcp/s/AbCdEfGh12345678
   ```

The profile must be on the same LoreMax as `LOREMAX_BASE_URL` and belong to the
organization of `LOREMAX_API_KEY`; the plugin calls it with the same key.

With `profile_url` set, the plugin uses only the profile: there is one catalog
for the agent. An invalid `profile_url` (a foreign origin, a wrong path, not
https) marks the plugin as needing configuration, and every tool replies with
the config error; the plugin never falls back to REST mode, because that would
silently show the agent the whole organization catalog. A profile that LoreMax
answers with 404 (unknown, disabled, or a key from another organization) fails
the same way, naming all three causes.

The profile's tool list is cached for 10 minutes and reread after a schema
change, an unavailable tool or an unknown tool name. There is no price before a
run in profile mode: every accepted `loremax_generate` call is charged, and the
authoritative token cost from LoreMax's reply is recorded.

Workflows a profile cannot hold (Scene/Reference Builder, Prompt Editor V2, 3D
Camera) need REST mode.

## Tools

The plugin always registers the same three tools, so agent prompts do not
change between modes; their arguments and descriptions do. Profile mode adds an
optional fourth, `loremax_profile_edit`, only with `allow_profile_edit: true`
(see [Editing the profile's texts](#editing-the-profiles-texts)).

REST mode:

| Tool | Cost | What |
|---|---|---|
| `loremax_workflows` | free | without `workflow_id`: `recommended` (the guide's best live workflows per task), the guide's `rules`, then the organization's workflows (id, visual id, title, category), optionally filtered by `query`. With `workflow_id`: its input fields (keys, types, options), usage hint, price in tokens and the guide's entry for it (`guide`) when there is one |
| `loremax_generate` | **paid** | run a workflow (`workflow_id` numeric or visual id) with `inputs` exactly as the fields name them and up to 20 `references` (`artifacts/…` or workspace files, ≤ 20 MB each, sent as files); wait `wait_s` (10–50 s, default `default_wait_s` = 45), download the outputs into `artifacts/<task>/`, record the spend. `note` (≤ 200 chars) is a provenance note; it defaults to the first 120 chars of `inputs.prompt` |
| `loremax_result` | free | status / result of a `generation_id` that outlived the wait, from this workspace only; optional `wait_s` (0–50 s, default 0 = one check). Saves outputs the same way, returns the saved paths when the generation already finished, or `status: failed` with LoreMax's error |

Profile mode:

| Tool | Cost | What |
|---|---|---|
| `loremax_workflows` | free | without `tool`: the studio's `instructions`, `recommended` (the guide's best profile tools per task), the guide's `rules`, then the profile's workflows (tool, title, category, a short description, the guide's `use_for`, required arguments, file arguments), optionally filtered by `query` over tool, title, category and visual id. With `tool`: its full description, the guide's entry for it (`guide`), its full argument schema (JSON Schema, never truncated), file arguments, media limits and how to call it |
| `loremax_generate` | **paid** | run a profile tool: `tool` and `arguments` exactly as its schema names them; file arguments take workspace paths, which the plugin uploads. `wait_s` and `note` as in REST mode. The plugin adds `schema_revision` and `on_behalf_of` (`bridex:<workspace>:<agent>`); the agent never sends them or an `api_key` |
| `loremax_result` | free | as in REST mode |
| `loremax_profile_edit` | free | only with `allow_profile_edit: true`: preview, then save, new texts for the profile's description and its tools' descriptions in LoreMax |

A 402 / "Insufficient tokens" from LoreMax raises one out-of-funds card in the
inbox. A 429 is retried once after `Retry-After` (capped at 30 s, and never
past the call's deadline); LoreMax allows 60 runs a minute and 1000 an hour.

## The routing guide

The plugin ships a curated guide, `guide.mjs` — the loremax counterpart of the
media plugin's `media-generation` wiki page. It covers 62 workflows of the
catalog shared by all organizations and 27 tasks across image, video, audio and
text, filled from a catalog export (see **Updating the guide** below).

- `rules`: model-agnostic rules of thumb (read the inputs before a paid call,
  one base character card varied through references, aspect ratio by placement,
  transparent backgrounds for game assets, text in the picture only with
  workflows whose description or guide says they render it, preview cheap then
  commit, one take per video scene, look at the result, cheap or draft only when
  asked);
- `workflows`: per workflow, keyed by its visual id (else `id:<n>`), `use_for`
  (one line), `knobs` (the inputs that matter) and `caveats` (what goes wrong);
- `routes`: tasks (a game asset with transparency, key art, a base character
  card, an edit, an upscale, a video from a first frame, …), each with the
  workflows to pick, best first.

The guide is always intersected with the live catalog: an entry whose workflow
the organization (or the profile) lacks is never shown, and a task with no live
pick is left out, so the agent never sees a workflow it cannot run.

What the agent sees in `loremax_workflows`:

| | List | Details |
|---|---|---|
| REST mode | `recommended: [{ task, workflows: [{ id, visual_id, title, why }] }]`, `rules`, `workflows`, `hint` | `guide: { use_for, knobs, caveats }` next to the input fields and price |
| Profile mode | `instructions`, `recommended: [{ task, tools: [{ tool, title, why }] }]`, `rules`, `tools` (each with `use_for` when the guide knows it), `hint` | `guide` next to the tool's own description and schema |

In REST mode `recommended` and `rules` come before the list, so a long list is
cut, never them. A profile's list (at most 25 tools) is shortened rather than
cut: when it would go over the size cap, the guide gives way first (`rules`, `why` and `use_for`,
then `recommended`), then each description shrinks to 100 characters; the
instructions stay whole and the hint says the list was shortened. With a
`query`, `recommended` is filtered by it and `rules` is left out. An empty
`recommended` is left out too.

In profile mode, `instructions` is the profile's description as the LoreMax
manager wrote it: the plugin reads it from the profile's `initialize` reply,
only when the agent lists the tools, and caches it for 10 minutes. LoreMax's
standard operating lines that follow it (polling, resubmitting, `api_key`, media
URLs — the plugin already does what they say) are dropped. When `initialize`
fails, `instructions` is `null` for that call and the list still works.

**Precedence**: the studio's instructions and each profile tool's own
description override the generic guide (`recommended`, `rules`, `use_for`,
`guide`) wherever they disagree; the list's hint says so. The guide is shown
alongside a tool's description, never instead of it. When a details reply would
go over its size cap, `guide` is dropped first; the schema is never cut.

**Updating the guide**: produce the catalog export (public fields of the
workflows available to all organizations, from a read-only script in the private
LoreMax repository) at `docs/catalog/loremax-workflows.json`, or point
`LOREMAX_CATALOG_EXPORT` at it; the path is git-ignored and never committed.
A usage table (generations and refunded generations per workflow) is the other
input: it orders a route's picks by what studios actually run and turns frequent
refunds into `caveats` — it stays local too, and only the resulting order and
wording reach `guide.mjs`.
Compare it against `guide.mjs`, update the entries and routes, run `npm test`
(the guide test then checks every key against the export) and release. Cheap or
draft workflows are never a route's first pick. In REST mode `recommended` and
`rules` must fit under the reply cap with every guide workflow live (a test
checks it): keep `use_for` to one short line and a route to its two or three
best picks — a workflow without a route still gets its `guide` in the details
and its `use_for` in a profile list. No organization-specific names,
provider URLs, prices or internal settings go into `guide.mjs` — this
repository is public.

## Editing the profile's texts

With `allow_profile_edit: true` (default `false`), profile mode registers
`loremax_profile_edit`. In REST mode, or with the flag off, the tool does not
exist. It writes into LoreMax, so the new texts reach **every client of the
profile**, not only Bridex.

It edits texts only: the profile's description (what the agent sees as
`instructions`) and the descriptions of tools already bound to it — never which
workflows are bound, the tool names or whether the profile is active.

```json
{ "instructions": "Studio rules for the art team…",
  "tools": [{ "tool": "styled_portrait", "description": "Our default for character cards…" }],
  "apply": false }
```

`instructions` omitted keeps the description; `null` or `""` clears it. Each
`tools[]` entry must carry a `description` (`null` or `""` clears it); to keep a
tool's text, leave the tool out of `tools`. Tools are named by their current
names as `loremax_workflows` lists them.

1. **Preview** (`apply: false`, the default): nothing is saved. The reply is
   `{ applied: false, incompatible, hint, warning?, changes: [{ field, before, after }] }`
   (`field` is `description` or `tool:<name>`), checked by LoreMax's own
   preview. A non-empty `incompatible` means LoreMax would refuse the save;
   it comes before `changes`, so a long diff is cut, never the verdict.
2. **Apply** (`apply: true`): the plugin rereads the profile right before
   saving, so the changes are recomputed against what LoreMax holds now, and
   saves it. The reply is `{ applied: true, hint, warning?, changes }`; the
   plugin then rereads the tool list and the instructions on the next call.

LoreMax's read also drops a URL's `#fragment` and `user:pass@`, leaving no
marker, and a save sends every unchanged text back as read. So when an
unchanged text holds a URL, both replies carry a `warning` that names it: to
keep such a part, pass that text in full in the same edit.

Refused before anything is saved:

- nothing to change requested, or a text over 2000 characters;
- a tool name that is not bound to the profile (the error lists the bound
  ones);
- a field that would be sent back unchanged but contains `[redacted]`, or a new
  text that contains it (usually a redacted `before` copied into the edit):
  LoreMax hides URL query strings when the profile is read, and saving would
  store the redaction in place of the real URL, so a person must fix it in
  LoreMax → Organization → MCP;
- a profile that binds a workflow LoreMax marks incompatible.

The texts already in place are reported as "nothing to change", with no save.
LoreMax's own refusals (400, with its issues and incompatible workflows) and an
unknown profile (404) come back as tool errors; a save that gets no reply (a
timeout, a dropped connection, a gateway 5xx without LoreMax's own body) may or
may not have been stored, so the agent previews again to see.

The plugin finds the profile's management id by its publicId in the
organization's profile list (cached until the LoreMax address or key changes;
an edit during which either changes stops before its next request, unsaved),
and every request costs one unit of the key's rate limit. LoreMax has no version check on a save: a manager's edit that
lands between the plugin's reread and its save is lost. Editing the same profile
from LoreMax and from an agent at the same time is best avoided.

## File arguments (profile mode)

A profile tool marks its file arguments with `x-loremax-media` (media type,
role, single or array, accepted formats, constraints). The agent passes
workspace paths — `artifacts/…` or files in its workdir — for them; an array
argument takes a list of paths. Before any upload the plugin checks each file:

- the path stays inside the workspace;
- its extension is in the argument's accepted formats;
- its size is within the argument's constraints and LoreMax's 50 MiB per file;
- the number of files fits the argument's cardinality and item bounds;
- the totals fit the tool's `x-loremax-limits` (image positions, all media
  positions, total unique bytes).

Then it uploads them (`request_upload_url` → `PUT` → `finalize_upload`) and
passes LoreMax's finalized URLs in their original order. Identical files are
uploaded once per call, and a finalized URL is reused for an hour, so calling
again after a refused or timed-out call does not upload the same bytes again.
An `https://` value is passed through unchanged; LoreMax accepts only finalized
URLs of the same organization. Any refused or failed upload stops the call
before the paid generation, with "nothing was charged".

## Errors the agent may see

In profile mode a call LoreMax refuses before any debit comes back as
`{status: "rejected", charged: false, error_code, error, hint}`, so the agent
fixes it and calls again:

| `error_code` | Meaning | The reply also carries |
|---|---|---|
| `INVALID_WORKFLOW_INPUT`, `MEDIA_INPUT_INVALID` | the arguments or files do not match the schema | `issues` and the tool's schema |
| `SCHEMA_REVISION_MISMATCH` | the workflow changed in LoreMax since the schema was read | the fresh schema (no automatic retry: defaults, bounds or required fields may have changed); when the reread itself fails, a hint to read it again with `loremax_workflows` |
| `WORKFLOW_UNAVAILABLE`, `TOOL_NOT_FOUND` | the tool is no longer published or not in the profile | the current tool list |

A call that ran and failed comes back as `{status: "failed", error_code?, error,
hint}`:

| `error_code` | Meaning |
|---|---|
| `INSUFFICIENT_TOKENS` | the balance is too low; the out-of-funds card is raised, `required_tokens` when LoreMax gives it. Carries `charged: false`: nothing was debited |
| `GENERATION_FAILED` (or none) | LoreMax could not run the generation; `generation_id` when there is one. LoreMax refunds failed runs, so the hint says to check its history rather than retry blindly |

These are thrown as tool errors instead:

- a config error: a `base_url` / `LOREMAX_BASE_URL` that is not `https://`,
  an invalid `profile_url`, `PROFILE_NOT_FOUND` (unknown or
  disabled profile, or a key from another organization), or
  `PROFILE_ORGANIZATION_MISMATCH` (the profile belongs to another organization
  than `LOREMAX_API_KEY`);
- a refused upload, or a call that ran out of time before the paid request
  ("nothing was charged");
- a redirect from LoreMax ("redirected — refused, the key must not leave
  <host>"): it is never followed, so the request did not reach the other host;
  on the paid request it is a "may have been charged" one, since LoreMax may
  have accepted the call before redirecting;
- a paid request that got no usable reply (timeout, dropped connection, a
  JSON-RPC error or an unreadable result): the generation may already have been
  charged, so the agent checks LoreMax before running it again.

## Waiting

Bridex agents' MCP client gives up on a tool call after 60 s, while the plugin
handler goes on unseen. So no tool call runs longer than 50 s from its start:
`default_wait_s` is 45, every `wait_s` is capped at 50, and the budget covers
everything the call does — catalog lookup, uploads, submission, polling,
Retry-After sleeps and downloads.

`loremax_generate` can hand back before the result in two ways:

- `status: "in_progress"` with a `generation_id`: LoreMax accepted the
  generation and it is tracked. The agent may end its turn; it is **woken**
  with the files (or polls `loremax_result`).
- `status: "submitting"`: LoreMax has not answered the paid request yet. The
  request goes on in the background; the reply says "do NOT call
  loremax_generate again — end your turn, you will be WOKEN with the result",
  and the agent is woken with the files, the error, or — when no reply ever
  came — the "may have been charged" text.

A call identical to one still being submitted — same workflow (or profile
tool), same `inputs` (or `arguments`), same reference files by content and in
the same order, to the same LoreMax (base URL, profile and API key: after a
settings change another server or organization is another request), from the
same caller (workspace, agent, session and task, where the wake and the outputs
go) — is refused before any request, so an agent that
retries while the first submission is still landing is not charged twice. The
reply is `status: "submitting"` with `duplicate_of` (the running submission's
`submit:<uuid>`, an identifier only: `loremax_result` does not take it) and the
same "do NOT call loremax_generate again" hint. The request is held only while it is being submitted: once
LoreMax accepts or refuses it, the same call submits again (a new paid run).

A generation that completes with less than ~10 s left, or whose downloads are
still running at the deadline, is saved in the background and the agent is
woken with the files. A synchronous result saved this way is tracked under its
own generation id too, so `loremax_result` finds it once it is saved, and a
save that fails (or a restart mid-download) is retried by the watcher from the
outputs kept on the job row, never through `/check`. On older cores without `ctx.jobs` / `ctx.wakeAgent`
nothing is detached: the submission blocks as in 0.1.0 (only polling respects
the budget), and in profile mode a call whose uploads leave less than 15 s is
stopped before the paid request, with "nothing was charged; uploads are cached
— call loremax_generate again".

A profile disabled in LoreMax stops new calls, but generations it already
started still finish: the watcher polls them through the REST status check.

## Outputs and provenance

Outputs are named `<workflow-slug>-<generationId>.<ext>` (with a `-1`, `-2`, …
suffix when one generation returns several files) inside the task's artifact
folder, or `artifacts/loremax/` outside a task. The slug is the workflow label
lower-cased with every non `[a-z0-9]` run turned into `-`: the `workflow_id` in
REST mode (so workflow `12` gives `12-501.png` and `Flux Portrait v2` gives
`flux-portrait-v2-501.png`), the workflow's visual id, title or tool name in
profile mode. The extension comes from the content type: images, video (mp4,
webm, mov, mkv, ts, m4v), audio (mp3, wav, m4a, ogg, flac, aac) and 3D models
(glb, gltf, obj, stl, usdz, fbx).

A Text workflow's output is saved as `<workflow-slug>-<generationId>.md` the
same way. The text is taken from LoreMax's reply, or from one status check when
a completed reply carries neither files nor text.

Originals are preferred over previews, previews over external URLs. A file over
512 MB, one whose download fails, or one that can't be written (full disk, no
permission) stays on LoreMax's CDN: the reply (and the watcher's wake-up) lists
its URL under `left_on_cdn`, and the spend is recorded all the same. Text has
no CDN copy: when its `.md` can't be written the spend is recorded, the job is
left running and the save is retried by the watcher (or the next
`loremax_result`) until it lands. A
synchronous workflow returns its outputs in the execute reply; they are saved
the same way, with no polling. Outputs are mirrored to the instance's cloud
bucket when one is configured.

Each file's sidecar carries a description (`LoreMax <workflow> · generation
<id> · <note>`, where `<note>` is the `note` argument or the start of the
`prompt` input or argument) and a `generation` block:

| Field | Value |
|---|---|
| `provider` | `LoreMax` |
| `workflow` | REST: the `workflow_id` as given. Profile: the workflow's visual id, else its title, else the tool name |
| `params` | REST: the `inputs` as sent. Profile: the agent's `arguments` with workspace paths (not the uploaded URLs), plus `tool` and `profile` (the publicId). Both add `image_urls` — the reference paths, when there were any |
| `externalId` | the LoreMax generation id |
| `costUsd` | tokens × `usd_per_token`, only when that is set |

Spend lands in the dashboard usage charts under kind `loremax`, model = the
workflow label, in tokens (`tk`), with USD when `usd_per_token` is set. It is
recorded once per generation (keyed by the generation id), even when a restart
finishes the same generation twice.

## The reboot-proof wait

`loremax_generate` tracks the generation in the instance DB from the first
second. If the wait runs out, the agent gets a `generation_id` back and may end
its turn. A watcher checks every pending generation through LoreMax's REST
status check (in both modes), less often as the generation ages: every 15 s
while it is under 2 min old, every 60 s until 30 min, every 5 min after that.
LoreMax's limit of 1000 requests an hour is per organization and shared with
the paid calls, so a few long video generations polled every 15 s would starve
`loremax_generate` with 429s; most generations finish in the first minutes,
where the check stays fast. A failed check keeps its schedule (no tight retry).
There is one watcher per process: a re-activation (settings save, update,
dashboard toggle) stops the previous one before starting its own. When a
generation completes, the outputs are saved and the agent is **woken** in the
session it came from with the file list; when it fails, the agent is woken with
the error. A server restart mid-wait loses neither the generation nor the tokens: the job row keeps the inputs (or the
profile tool and arguments), references, token spend and note (as `track()`
params), so the watcher saves the outputs with full provenance. Older cores keep
only the label, which carries the token spend (`hero · 12 tk`), so the spend is
still recorded. Status-check errors (network, rate limit) don't fail the job;
the watcher retries on the same schedule. A generation still pending after 6 h is settled as
failed and the agent is woken to say so.

A submission still waiting for LoreMax's answer is tracked too, as a
`submit:<uuid>` placeholder row. If the server restarts before LoreMax answers,
the watcher settles that row as failed and wakes the agent once: the submission
was interrupted and may have been charged, so check LoreMax history before
running it again.

The plugin check reports whether the key works and the token balance (it fails
with "balance is empty — top up LoreMax" when the key works but no tokens
remain). In profile mode it reads the balance through the profile and rereads
its tool list: "profile reachable, N tools · … tk left", failing when the profile
has no workflows, when the key works but the tool list cannot be read, on a
404 profile (with the three causes), an invalid `profile_url`, a `base_url`
that is not `https://` (naming the setting), or a redirect from LoreMax
("redirected — refused, the key must not leave <host>"). The dashboard shows a "LoreMax balance" tile, marked "running
out" when it is empty or under 10 % of the limit.

## For the studio

- The default workflow per asset kind is named in the studio's
  `studio/art-guide.md` wiki page, which people edit and the illustrator reads
  before every picture — not in this plugin's config. With a profile, the page
  names the profile's tool names (as `loremax_workflows` lists them) instead of
  workflow ids. The plugin's routing guide is a generic starting point; with a
  profile, the profile's description and tool descriptions, written in LoreMax,
  reach the agent too and override it.
- References come from `artifacts/studio-references/`; they are stored in
  `params.image_urls`, so the studio's Source card shows their thumbnails with
  no UI change.

## Why kind: integration

The plugin writes into workspace artifacts, stamps provenance, records usage,
tracks jobs and wakes agents — in-process facilities. A catalog plugin of kind
`tool` runs out-of-process with flat schemas and no artifact access, so this one
must stay `integration`.

## Development

```sh
npm test    # node --test test/ — a fake ctx and a mocked fetch, no network
```

A release bumps `version` in `package.json`, `plugin.yaml` and `PLUGIN_VERSION`
in `index.mjs` together; `npm test` fails when they differ.
