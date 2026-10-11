# Changelog

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
- Config: `api_key` / `base_url` from the managed `LOREMAX_API_KEY` / `LOREMAX_BASE_URL` credentials,
  `default_wait_s` (180), optional `usd_per_token`.
