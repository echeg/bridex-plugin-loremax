# Long-waiting media tools can outlive a CLI agent's MCP tool timeout

- found: 2026-10-11, plan: 20261011-loremax-plugin, phase: internal review
- updated: 2026-10-12, plan: 20261011-loremax-profile-dispatcher (the plugin side is mitigated; the host fix stays open)
- severity: major
- area: bridex host server/src/runtime/cliMcpConfig.ts and server/src/runtime/mcpClient.ts (affects host media_video,
  fal_run; this plugin now works around it)

A media tool that waits for its result inside the call only works if the MCP client waits that long. The host's
built-in `media_video` (server/src/plugins/tools/media.ts:378, watcher skip ~:300) and `bridex-plugin-fal` (`fal_run`,
default 180 s) wait in the call and skip the job in their watcher while they do, so no wake is sent if the call itself
saves the result. When the client gives up first, the agent gets "tool timed out" while the server-side handler goes
on: it saves, bills and settles the generation, and no wake is ever sent. The agent never learns the generation id and
may pay to generate again. `PluginToolCall` has no abort signal, so a plugin cannot tell that its caller is gone.

Confirmed: the Bridex llm adapter calls tools with the MCP SDK's default request timeout of 60 s
(studio `server/src/runtime/mcpClient.ts:154`, `@modelcontextprotocol/sdk` 1.29.0 `DEFAULT_REQUEST_TIMEOUT_MSEC =
60000`; `callTool` is called without a timeout). `cliMcpConfig.ts` sets no per-tool timeout for CLI adapters either;
Codex's default `tool_timeout_sec` is believed to be 60 s, not confirmed.

This plugin (0.2.0) no longer depends on the client waiting longer:

- every tool call is capped at 50 s from its start (`MAX_WAIT_S`, index.mjs:41; `default_wait_s` 45, index.mjs:40),
  and that budget covers catalog lookup, uploads, submission, polling in `waitFor` (index.mjs:1741), Retry-After
  sleeps and downloads;
- a paid submission that LoreMax has not answered in time is detached (`raceBudget`, index.mjs:1590): the call replies
  `submitting`, the submission goes on in the background behind a `submit:<uuid>` placeholder row (index.mjs:1480),
  and the agent is woken with the result; a save that would run past the deadline is detached the same way;
- a restart mid-submission settles the placeholder and wakes the agent once (watcher, index.mjs:1858).

Still to do in the host: set `tool_timeout_sec` (for example 1600 s) for the Bridex MCP server in `cliMcpConfig.ts`
for codex, and pass a timeout to `callTool` in `mcpClient.ts` — or have the host pass an abort signal / "caller gone"
flag into plugin tool calls, so a plugin can hand the job back to its watcher, which then sends the wake. Do this for
all long-waiting tools at once, not per plugin. Then this plugin's 50 s cap can be relaxed.
