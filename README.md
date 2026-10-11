# bridex-plugin-loremax

[LoreMax](https://loremax.ai) image and video generation for Bridex agents,
through the organization's own workflows. An agent lists the workflows, reads
one workflow's input fields and price (both free), runs it with inputs passed
through unchanged and reference files taken from its workspace, and gets the
outputs saved into its task's artifacts with provenance and token spend.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog, or the operator
MCP `plugin_admin install loremax`), then set the credentials:

- **Settings → Integrations → LoreMax key** (`LOREMAX_API_KEY`, format
  `lmx_prod_…`, created in LoreMax under API keys). Read per call — no restart
  needed.
- **Settings → Integrations → LoreMax address** (`LOREMAX_BASE_URL`) — only when
  LoreMax is not at `https://loremax.ai`. Empty means the default.

Without a key the tools still register; each call answers with the hint to set
it, and the plugin card shows "needs config".

Optional `bridex.yaml`:

```yaml
plugins:
  loremax:
    config:
      api_key: ${LOREMAX_API_KEY}     # default
      base_url: ${LOREMAX_BASE_URL}   # default; empty = https://loremax.ai
      default_wait_s: 180             # how long loremax_generate waits before handing back a generation_id
      usd_per_token: 0.001            # optional: tokens → USD for the spend charts; absent = tokens only
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `loremax_workflows` | free | without `workflow_id`: the organization's workflows (id, visual id, title, category), optionally filtered by `query`. With `workflow_id`: its input fields (keys, types, options), usage hint and price in tokens |
| `loremax_generate` | **paid** | run a workflow (`workflow_id` numeric or visual id) with `inputs` exactly as the fields name them and up to 20 `references` (`artifacts/…` or workspace files, ≤ 20 MB each, sent as files); wait (default 3 min), download the outputs into `artifacts/<task>/`, record the spend |
| `loremax_result` | free | status / result of a `generation_id` that outlived the wait; saves outputs the same way, or returns the saved paths when the generation already finished |

A 402 / "Insufficient tokens" from LoreMax raises one out-of-funds card in the
inbox. A 429 is retried once after `Retry-After` (capped at 30 s); LoreMax
allows 60 runs a minute and 1000 an hour.

## Outputs and provenance

Outputs are named `<workflow-slug>-<generationId>.<ext>` (with a `-1`, `-2`, …
suffix when one generation returns several files) inside the task's artifact
folder, or `artifacts/loremax/` outside a task. The slug is the `workflow_id`
lower-cased with every non `[a-z0-9]` run turned into `-`, so workflow `12`
gives `12-501.png` and `Flux Portrait v2` gives `flux-portrait-v2-501.png`.
Originals are preferred over previews; files over 512 MB stay on LoreMax's CDN.
Outputs are mirrored to the instance's cloud bucket when one is configured.

Each file's sidecar carries a description (`LoreMax <workflow> · generation
<id> · <note>`) and a `generation` block:

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
A server restart mid-wait loses neither the generation nor the tokens. A
generation still pending after 6 h is given up.

The plugin check reports whether the key works and the token balance; the
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
