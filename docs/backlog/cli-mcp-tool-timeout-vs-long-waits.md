# Long-waiting media tools can outlive a CLI agent's MCP tool timeout

- found: 2026-10-11, plan: 20261011-loremax-plugin, phase: internal review
- severity: major
- area: bridex host server/src/runtime/cliMcpConfig.ts (affects index.mjs waitFor here, host media_video, fal_run)

`loremax_generate` waits up to `default_wait_s` (180 s, index.mjs:71) inside `waitFor` (index.mjs:615). While it waits,
the watcher skips the job (`inFlight`, index.mjs:670), so no wake is sent if the tool call itself saves the result.
The host's built-in `media_video` (server/src/plugins/tools/media.ts:378, watcher skip ~:300) and `bridex-plugin-fal`
(`fal_run`, default 180 s) use the same pattern.

This only works if the MCP client waits that long. Bridex's `cliMcpConfig.ts` (studio branch) sets no per-tool timeout
for CLI adapters. Codex's default `tool_timeout_sec` is believed to be 60 s, but this is not confirmed. If so, a Codex
agent gets "tool timed out" while the server-side handler goes on: it saves, bills and settles the generation, and no
wake is ever sent. The agent never learns the generation_id and may pay to generate again.

Fix direction: set `tool_timeout_sec` (for example 1600 s, above the 1500 s max `wait_s`) for the Bridex MCP server in
`cliMcpConfig.ts` for codex. Or have the host pass an abort signal / "caller gone" flag into plugin tool calls, so a
plugin can hand the job back to its watcher, which then sends the wake. Do this for all long-waiting tools at once,
not per plugin.
