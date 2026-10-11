# bridex-plugin-loremax

[LoreMax](https://loremax.ai) image and video generation for Bridex agents,
through the organization's own workflows. An agent lists the workflows, reads
one workflow's input fields and price (both free), runs it with inputs passed
through unchanged and reference files taken from its workspace, and gets the
outputs saved into its task's artifacts with provenance and token spend.

## Requirements

Node ≥ 20 (built-in `fetch`, `FormData`, `Blob`, `node:test`; no dependencies).
Job tracking, the reboot-proof watcher and the agent wake-up need a Bridex core
with `ctx.jobs` / `ctx.wakeAgent`; the out-of-funds card needs `ctx.billing` and
the balance tile `ctx.registerStat`. On older cores the plugin still loads: a
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

Optional `bridex.yaml`:

```yaml
plugins:
  loremax:
    config:
      api_key: ${LOREMAX_API_KEY}     # default
      base_url: ${LOREMAX_BASE_URL}   # default
      default_wait_s: 180             # how long loremax_generate waits before handing back a generation_id (10..1500; empty or invalid = 180)
      usd_per_token: 0.001            # optional: tokens → USD for the spend charts; absent = tokens only
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `loremax_workflows` | free | without `workflow_id`: the organization's workflows (id, visual id, title, category), optionally filtered by `query`. With `workflow_id`: its input fields (keys, types, options), usage hint and price in tokens |
| `loremax_generate` | **paid** | run a workflow (`workflow_id` numeric or visual id) with `inputs` exactly as the fields name them and up to 20 `references` (`artifacts/…` or workspace files, ≤ 20 MB each, sent as files); wait `wait_s` (10–1500 s, default `default_wait_s` = 180), download the outputs into `artifacts/<task>/`, record the spend. `note` (≤ 200 chars) is a provenance note; it defaults to the first 120 chars of `inputs.prompt` |
| `loremax_result` | free | status / result of a `generation_id` that outlived the wait, from this workspace only; optional `wait_s` (0–1500 s, default 0 = one check). Saves outputs the same way, returns the saved paths when the generation already finished, or `status: failed` with LoreMax's error |

A 402 / "Insufficient tokens" from LoreMax raises one out-of-funds card in the
inbox. A 429 is retried once after `Retry-After` (capped at 30 s); LoreMax
allows 60 runs a minute and 1000 an hour.

## Outputs and provenance

Outputs are named `<workflow-slug>-<generationId>.<ext>` (with a `-1`, `-2`, …
suffix when one generation returns several files) inside the task's artifact
folder, or `artifacts/loremax/` outside a task. The slug is the `workflow_id`
lower-cased with every non `[a-z0-9]` run turned into `-`, so workflow `12`
gives `12-501.png` and `Flux Portrait v2` gives `flux-portrait-v2-501.png`.
Originals are preferred over previews, previews over external URLs. A file over 512 MB, one whose
download fails, or one that can't be written (full disk, no permission) stays on
LoreMax's CDN: the reply (and the watcher's wake-up) lists its URL under
`left_on_cdn`, and the spend is recorded all the same. A synchronous workflow (any execute reply that isn't `async`)
returns its outputs in the execute reply; they are saved the same way, with no
polling. If the execute call gets no reply at all (timeout or dropped
connection), the error says the generation may already have been charged, so
the agent checks LoreMax before running it again.
Outputs are mirrored to the instance's cloud bucket when one is configured.

Each file's sidecar carries a description (`LoreMax <workflow> · generation
<id> · <note>`, where `<note>` is the `note` argument or the start of
`inputs.prompt`) and a `generation` block:

| Field | Value |
|---|---|
| `provider` | `LoreMax` |
| `workflow` | the `workflow_id` as given |
| `params` | the `inputs` as sent, plus `image_urls` — the reference paths, when there were any |
| `externalId` | the LoreMax generation id |
| `costUsd` | tokens × `usd_per_token`, only when that is set |

Spend lands in the dashboard usage charts under kind `loremax`, model = the
workflow, in tokens (`tk`), with USD when `usd_per_token` is set.

## The reboot-proof wait

`loremax_generate` tracks the generation in the instance DB from the first
second. If the wait runs out, the agent gets a `generation_id` back and may end
its turn. A watcher polls every pending generation every 15 s: when it
completes, the outputs are saved and the agent is **woken** in the session it
came from with the file list; when it fails, the agent is woken with the error.
A server restart mid-wait loses neither the generation nor the tokens: the job
row keeps the inputs, references, token spend and note (as `track()` params), so
the watcher saves the outputs with full provenance. Older cores keep only the
label, which carries the token spend (`hero · 12 tk`), so the spend is still
recorded. Status-check errors (network, rate limit) don't fail
the job; the watcher keeps retrying. A generation still pending after 6 h is
settled as failed and the agent is woken to say so.

The plugin check reports whether the key works and the token balance (it fails
with "balance is empty — top up LoreMax" when the key works but no tokens
remain); the
dashboard shows a "LoreMax balance" tile, marked "running out" when it is empty
or under 10 % of the limit.

## For the studio

- The default workflow per asset kind is named in the studio's
  `studio/art-guide.md` wiki page, which people edit and the illustrator reads
  before every picture — not in this plugin's config.
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
