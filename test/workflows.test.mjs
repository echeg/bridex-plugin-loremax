import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult, mcpError, fakeSleep } from "./helpers.mjs";

const BASE = "https://lm.test";
const tool = async (opts) => {
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  await activate(ctx, opts);
  const t = rec.tools.get("loremax_workflows");
  return { run: async (args) => JSON.parse((await t.handler(args, {})).content[0].text), rec };
};

const LIST = {
  workflows: [
    { id: 11, visualId: "flux-portrait", title: "Flux portrait", description: "Character portrait. ".repeat(20), category: "image", isEnabled: true },
    { id: 12, visualId: "kling-i2v", title: "Kling image to video", description: "Animates a still", category: "video", isEnabled: true },
  ],
};

/** Route MCP tools/call by tool name. */
const mcpRoute = (byTool) => ["POST", "/api/mcp", (req) => byTool[req.json.params.name](req.json.params.arguments)];

let restore = () => {};
afterEach(() => {
  restore();
  restore = () => {};
});

test("registers loremax_workflows as a free tool", async () => {
  const { rec } = await tool();
  const t = rec.tools.get("loremax_workflows");
  assert.ok(t);
  assert.match(t.description, /free/i);
  assert.match(t.description, /before a paid loremax_generate/);
});

test("list: maps fields, caps the description at 200 chars, adds a hint", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const { run } = await tool();
  const r = await run({});
  assert.equal(f.calls[0].url, `${BASE}/api/v1/workflows`);
  assert.equal(r.workflows.length, 2);
  assert.deepEqual(Object.keys(r.workflows[0]), ["id", "visual_id", "title", "category", "description"]);
  assert.equal(r.workflows[0].visual_id, "flux-portrait");
  assert.equal(r.workflows[0].description.length, 200);
  assert.match(r.hint, /workflow_id/);
});

test("list: query filters case-insensitively over title/description/visual_id/category", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const { run } = await tool();
  assert.deepEqual((await run({ query: "VIDEO" })).workflows.map((w) => w.id), [12]);
  assert.deepEqual((await run({ query: "flux-por" })).workflows.map((w) => w.id), [11]);
  assert.deepEqual((await run({ query: "animates" })).workflows.map((w) => w.id), [12]);
  const none = await run({ query: "nothing-like-this" });
  assert.deepEqual(none.workflows, []);
  assert.match(none.hint, /no workflow matches/);
});

test("details: merges fields with the price, no REST list call", async () => {
  const f = mockFetch([
    mcpRoute({
      get_workflow_details: () =>
        mcpResult({
          id: 11,
          visual_id: "flux-portrait",
          title: "Flux portrait",
          category: "image",
          description: "d",
          input_fields: [{ key: "prompt", type: "textarea", label: "Prompt", config: {} }],
          usage_hint: "describe the character",
        }),
      get_pricing: () => mcpResult({ tokenCost: 40 }),
    }),
  ]);
  restore = f.restore;
  const { run } = await tool();
  const r = await run({ workflow_id: "flux-portrait" });
  assert.deepEqual(f.calls.map((c) => c.json.params.name), ["get_workflow_details", "get_pricing"]);
  // LoreMax's get_workflow_details schema is { visual_id }; get_pricing's is { workflowId }
  assert.deepEqual(f.calls[0].json.params.arguments, { visual_id: "flux-portrait" });
  assert.deepEqual(f.calls[1].json.params.arguments, { workflowId: "flux-portrait" });
  assert.deepEqual(r.workflow, { id: 11, visual_id: "flux-portrait", title: "Flux portrait", category: "image", description: "d" });
  assert.equal(r.input_fields[0].key, "prompt");
  assert.equal(r.usage_hint, "describe the character");
  assert.equal(r.token_cost, 40);
  assert.equal(r.price, undefined);
  assert.equal("pricing_variables_required" in r, false);
});

test("details: a failing get_pricing still returns the fields with price unavailable", async () => {
  const f = mockFetch([
    mcpRoute({
      get_workflow_details: () =>
        mcpResult({ id: 12, visual_id: "kling-i2v", title: "Kling", input_fields: [{ key: "duration", type: "select" }], pricing_variables_required: ["duration"] }),
      get_pricing: () => mcpError("pricing needs duration"),
    }),
  ]);
  restore = f.restore;
  const { run } = await tool();
  const r = await run({ workflow_id: "12" });
  assert.equal(r.workflow.visual_id, "kling-i2v");
  assert.equal(r.input_fields[0].key, "duration");
  assert.deepEqual(r.pricing_variables_required, ["duration"]);
  assert.equal(r.token_cost, undefined);
  assert.match(r.price, /^unavailable: .*pricing needs duration/);
});

test("details: get_pricing HTTP failure is also non-fatal", async () => {
  const f = mockFetch([
    mcpRoute({
      get_workflow_details: () => mcpResult({ id: 11, input_fields: [] }),
      get_pricing: () => jsonResponse({ error: "boom" }, 500),
    }),
  ]);
  restore = f.restore;
  const { run } = await tool();
  const r = await run({ workflow_id: "11" });
  assert.match(r.price, /^unavailable: loremax 500/);
});

test("details: an unknown workflow surfaces LoreMax's error text", async () => {
  const f = mockFetch([mcpRoute({ get_workflow_details: () => mcpError("Workflow not found: nope") })]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  await activate(ctx);
  await assert.rejects(rec.tools.get("loremax_workflows").handler({ workflow_id: "nope" }, {}), /Workflow not found: nope/);
  assert.equal(f.calls.length, 1);
});

test("details: a huge field dump is capped at 14 000 chars", async () => {
  const fields = Array.from({ length: 400 }, (_, i) => ({ key: `field_${i}`, type: "text", label: "x".repeat(60), config: {} }));
  const f = mockFetch([
    mcpRoute({
      get_workflow_details: () => mcpResult({ id: 1, input_fields: fields }),
      get_pricing: () => mcpResult({ tokenCost: 1 }),
    }),
  ]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  await activate(ctx);
  const out = (await rec.tools.get("loremax_workflows").handler({ workflow_id: "1" }, {})).content[0].text;
  assert.ok(out.length <= 14_000 + "\n…(truncated)".length);
  assert.ok(out.endsWith("…(truncated)"));
});

test("REST mode: the call stays under the client timeout — a Retry-After that does not fit in 50 s is not slept", async () => {
  const clock = { t: 0 };
  // each request takes 25 s on a slow network: a 30 s Retry-After after one no longer fits
  const slow = (reply) => () => ((clock.t += 25_000), reply);
  const f = mockFetch([
    ["GET", "/api/v1/workflows", slow(jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" }))],
    mcpRoute({
      get_workflow_details: slow(mcpResult({ id: 11, input_fields: [{ key: "prompt" }] })),
      get_pricing: slow(jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" })),
    }),
  ]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const time = fakeSleep(clock);
  await activate(ctx, { now: () => clock.t, sleep: time.sleep });
  const t = rec.tools.get("loremax_workflows");
  await assert.rejects(t.handler({}, {}), /out of time/);
  // the price is a courtesy: out of time for it, the fields still come back
  const r = JSON.parse((await t.handler({ workflow_id: "11" }, {})).content[0].text);
  assert.equal(r.input_fields[0].key, "prompt");
  assert.match(r.price, /^unavailable: .*out of time/);
  assert.deepEqual(time.slept, []);
});

test("REST mode: schema and calls are 0.1.0's; the description adds the guide", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const { run, rec } = await tool();
  const t = rec.tools.get("loremax_workflows");
  assert.deepEqual(Object.keys(t.schema), ["workflow_id", "query"]);
  assert.match(t.description, /price in LoreMax tokens — ALWAYS read it before a paid loremax_generate/);
  assert.match(t.description, /Start from recommended, the best live workflow per task/);
  assert.match(t.description, /cheap or draft workflows only when someone asked/);
  assert.doesNotMatch(t.description, /curated/);
  await run({});
  assert.ok(f.calls.every((c) => !c.url.includes("/api/mcp/s/")));
});

// ---------- REST mode: the routing guide ----------

const GUIDE_T = {
  rules: ["rule one", "rule two"],
  workflows: {
    "flux-portrait": { use_for: "character portraits", knobs: "prompt, aspect_ratio", caveats: "no text" },
    "id:12": { use_for: "animate a still", knobs: "duration", caveats: "one take" },
    "gone-model": { use_for: "not in this organization" },
  },
  routes: [
    { task: "portrait", pick: ["gone-model", "flux-portrait"] },
    { task: "video from a frame", pick: ["id:12", "flux-portrait"] },
    { task: "dead route", pick: ["gone-model"] },
  ],
};
const EMPTY_GUIDE = { rules: ["only a rule"], workflows: {}, routes: [] };

test("guide list: recommended first, live picks only, dead route dropped, then rules and workflows", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  const r = await run({});
  assert.deepEqual(Object.keys(r), ["recommended", "rules", "workflows", "hint"]);
  assert.deepEqual(r.recommended, [
    { task: "portrait", workflows: [{ id: 11, visual_id: "flux-portrait", title: "Flux portrait", why: "character portraits" }] },
    {
      task: "video from a frame",
      workflows: [
        { id: 12, visual_id: "kling-i2v", title: "Kling image to video", why: "animate a still" },
        { id: 11, visual_id: "flux-portrait", title: "Flux portrait", why: "character portraits" },
      ],
    },
  ]);
  assert.deepEqual(r.rules, ["rule one", "rule two"]);
  assert.equal(r.workflows.length, 2);
});

test("guide list: an organization with none of the picks gets no recommended key", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => ({ workflows: [{ id: 99, visualId: "other", title: "Other", category: "image" }] })]]);
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  const r = await run({});
  assert.equal("recommended" in r, false);
  assert.deepEqual(r.rules, ["rule one", "rule two"]);
});

test("guide list: recommended and rules survive cap() with a huge list", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 100 + i, visualId: `w-${i}`, title: `Workflow ${i}`, description: "x".repeat(200), category: "image" }));
  const f = mockFetch([["GET", "/api/v1/workflows", () => ({ workflows: [...many, ...LIST.workflows] })]]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  await activate(ctx, { guide: GUIDE_T });
  const out = (await rec.tools.get("loremax_workflows").handler({}, {})).content[0].text;
  assert.ok(out.endsWith("…(truncated)"));
  const listAt = out.indexOf('\n "workflows": [');
  assert.ok(listAt > 0);
  const head = out.slice(0, listAt);
  assert.match(head, /"recommended"/);
  assert.match(head, /"why": "animate a still"/);
  assert.match(head, /"rule two"/);
});

test("guide list: query filters recommended and drops rules", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  // by task: the whole route
  const byTask = await run({ query: "video from" });
  assert.equal("rules" in byTask, false);
  assert.deepEqual(byTask.recommended.map((x) => [x.task, x.workflows.map((w) => w.id)]), [["video from a frame", [12, 11]]]);
  // no row matches the task's words, yet recommended does: the hint leads on, never "no workflow matches"
  assert.deepEqual(byTask.workflows, []);
  assert.match(byTask.hint, /call loremax_workflows with workflow_id/);
  // by item: only the matching workflows of each route
  const byItem = await run({ query: "kling" });
  assert.equal("rules" in byItem, false);
  assert.deepEqual(byItem.recommended.map((x) => [x.task, x.workflows.map((w) => w.id)]), [["video from a frame", [12]]]);
  assert.deepEqual(byItem.workflows.map((w) => w.id), [12]);
  const none = await run({ query: "nothing-like-this" });
  assert.deepEqual(Object.keys(none), ["workflows", "hint"]);
});

test("guide list: an empty guide changes nothing but rules", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => LIST]]);
  restore = f.restore;
  const plain = await (await tool({ guide: { rules: [], workflows: {}, routes: [] } })).run({});
  const ruled = await (await tool({ guide: EMPTY_GUIDE })).run({});
  assert.deepEqual(Object.keys(plain), ["workflows", "hint"]);
  assert.deepEqual(ruled, { rules: ["only a rule"], ...plain });
});

const detailsMock = (d) =>
  mockFetch([mcpRoute({ get_workflow_details: () => mcpResult(d), get_pricing: () => mcpResult({ tokenCost: 5 }) })]);

test("guide details: matched by visual id, asked for by numeric id", async () => {
  const f = detailsMock({ id: 11, visual_id: "flux-portrait", title: "Flux portrait", input_fields: [] });
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  const r = await run({ workflow_id: "11" });
  assert.deepEqual(r.guide, { use_for: "character portraits", knobs: "prompt, aspect_ratio", caveats: "no text" });
  assert.equal(r.token_cost, 5);
});

test("guide details: matched by numeric id, asked for by visual id", async () => {
  const f = detailsMock({ id: 12, visual_id: "kling-i2v", title: "Kling", input_fields: [] });
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  const r = await run({ workflow_id: "kling-i2v" });
  assert.deepEqual(r.guide, { use_for: "animate a still", knobs: "duration", caveats: "one take" });
});

test("guide details: LoreMax's reply without ids still matches the id the agent gave", async () => {
  const f = detailsMock({ input_fields: [] });
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  assert.equal((await run({ workflow_id: "12" })).guide.use_for, "animate a still");
  assert.equal((await run({ workflow_id: "flux-portrait" })).guide.use_for, "character portraits");
});

test("guide details: no guide key when the workflow has no entry", async () => {
  const f = detailsMock({ id: 99, visual_id: "other", input_fields: [] });
  restore = f.restore;
  const { run } = await tool({ guide: GUIDE_T });
  const r = await run({ workflow_id: "other" });
  assert.equal("guide" in r, false);
  assert.equal(r.token_cost, 5);
});

// ---------- profile mode ----------

const PROFILE = "AbCdEfGh12345678";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));

/**
 * loremax_workflows in profile mode; the profile answers tools/list with `tools()` (re-read per
 * request) and initialize with `init(req)` when given (a Response, or the JSON-RPC result).
 */
async function profileTool(tools = () => structuredClone(FIXTURE.result.tools), { guide, init } = {}) {
  const f = mockFetch([[
    "POST",
    `/api/mcp/s/${PROFILE}`,
    async (req) => {
      if (init && req.json.method === "initialize") {
        const out = await init(req);
        return out instanceof Response ? out : jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: out });
      }
      return jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: { tools: tools() } });
    },
  ]]);
  // a test may build two of these: the real fetch comes back only once both are undone
  const before = restore;
  restore = () => {
    f.restore();
    before();
  };
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  await activate(ctx, guide ? { guide } : {});
  const t = rec.tools.get("loremax_workflows");
  const raw = async (args) => (await t.handler(args, {})).content[0].text;
  const lists = () => f.calls.filter((c) => c.json?.method === "tools/list").length;
  const inits = () => f.calls.filter((c) => c.json?.method === "initialize").length;
  return { t, raw, run: async (args) => JSON.parse(await raw(args)), f, rec, lists, inits };
}

test("profile: registered with {tool, query} and a curated, free, price-less description", async () => {
  const { t } = await profileTool();
  assert.deepEqual(Object.keys(t.schema), ["tool", "query"]);
  assert.match(t.description, /curated/);
  assert.match(t.description, /free/);
  assert.match(t.description, /No price is shown/);
  assert.doesNotMatch(t.description, /workflow_id/);
});

test("profile list: generation tools only, with required and file_args; no REST call", async () => {
  const { run, f } = await profileTool();
  const r = await run({});
  assert.ok(f.calls.every((c) => c.url === `${BASE}/api/mcp/s/${PROFILE}`));
  assert.deepEqual(r.tools.map((t) => t.tool), ["write_text", "masked_edit", "styled_portrait"]);
  const masked = r.tools.find((t) => t.tool === "masked_edit");
  assert.deepEqual(Object.keys(masked), ["tool", "title", "category", "description", "required", "file_args"]);
  assert.equal(masked.category, "Image");
  assert.ok(masked.description.length <= 200);
  assert.ok(!masked.required.includes("schema_revision"));
  assert.ok(masked.required.includes("source"));
  assert.deepEqual(masked.file_args, [
    { name: "source", mediaType: "image", cardinality: "single" },
    { name: "edit_mask", mediaType: "image", cardinality: "single" },
  ]);
  assert.deepEqual(r.tools.find((t) => t.tool === "write_text").file_args, []);
  assert.match(r.hint, /with tool/);
});

test("profile list: query filters over tool, title, category and visual id", async () => {
  const { run, lists } = await profileTool();
  const names = async (query) => (await run({ query })).tools.map((t) => t.tool);
  assert.deepEqual(await names("WRITE_"), ["write_text"]); // tool name
  assert.deepEqual(await names("styled port"), ["styled_portrait"]); // title
  assert.deepEqual(await names("portraits"), ["styled_portrait"]); // category
  assert.deepEqual(await names("masked-edit"), ["masked_edit"]); // visual id
  const none = await run({ query: "nothing-like-this" });
  assert.deepEqual(none.tools, []);
  assert.match(none.hint, /no tool matches "nothing-like-this"/);
  // the catalog is cached: one tools/list for all of these
  assert.equal(lists(), 1);
});

test("profile list: an empty profile says so", async () => {
  const { run } = await profileTool(() => FIXTURE.result.tools.filter((t) => !t.inputSchema?.properties?.schema_revision));
  const r = await run({});
  assert.deepEqual(r.tools, []);
  assert.match(r.hint, /no workflows/);
});

test("profile details: agent schema without injected args, full file_args, limits and how_to_call", async () => {
  const { run } = await profileTool();
  const r = await run({ tool: "masked_edit" });
  assert.deepEqual(Object.keys(r), ["tool", "title", "description", "schema", "file_args", "limits", "how_to_call"]);
  assert.equal(r.tool, "masked_edit");
  for (const k of ["schema_revision", "api_key", "on_behalf_of"]) {
    assert.ok(!(k in r.schema.properties), k);
    assert.ok(!r.schema.required.includes(k), k);
  }
  assert.ok(r.schema.properties.source["x-loremax-media"]);
  const mask = r.file_args.find((a) => a.name === "edit_mask");
  assert.equal(mask.role, "mask");
  assert.deepEqual(mask.acceptedFormats, ["png"]);
  assert.deepEqual(mask.pairedWith, { key: "source", index: 0 });
  assert.ok(r.limits && typeof r.limits === "object");
  assert.match(r.how_to_call, /workspace paths/);
  assert.match(r.how_to_call, /artifacts\//);
  assert.match(r.how_to_call, /x-loremax-conditions/);
  // a tool without root limits
  assert.equal((await run({ tool: "write_text" })).limits, null);
});

test("profile details: an unknown tool refreshes the catalog once, then lists the names", async () => {
  const { t, lists } = await profileTool();
  await assert.rejects(t.handler({ tool: "nope" }, {}), /no such tool "nope" in this profile — tools: write_text, masked_edit, styled_portrait/);
  assert.equal(lists(), 2);
});

test("profile details: a tool added since the last read is found by the refresh", async () => {
  let extra = [];
  const { run, lists } = await profileTool(() => [...structuredClone(FIXTURE.result.tools), ...extra]);
  await run({});
  extra = [{ name: "fresh_tool", title: "Fresh", inputSchema: { type: "object", properties: { prompt: { type: "string" }, schema_revision: { type: "string", enum: ["r9"] } }, required: ["schema_revision", "prompt"] } }];
  const r = await run({ tool: "fresh_tool" });
  assert.equal(r.tool, "fresh_tool");
  assert.deepEqual(r.schema.required, ["prompt"]);
  assert.equal(lists(), 2);
});

/** A generation tool whose schema JSON is about `kb` KB, with a long description (and `_meta` visual id "big-tool" with `meta`). */
const bigTool = (kb, description = "d".repeat(4000), { meta = false } = {}) => {
  const properties = { schema_revision: { type: "string", enum: ["rbig"] } };
  for (let i = 0; JSON.stringify(properties).length < kb * 1024; i++)
    properties[`field_${i}`] = { type: "string", title: `Field ${i}`, description: "x".repeat(200) };
  return {
    name: "big_tool",
    title: "Big",
    description,
    inputSchema: { type: "object", properties, required: ["schema_revision"] },
    ...(meta ? { _meta: { "loremax.ai/workflow": { version: 1, workflowId: 77, visualId: "big-tool", title: "Big", category: "Image" } } } : {}),
  };
};

test("profile details: within the cap the full description and how_to_call are kept", async () => {
  const { run } = await profileTool(() => [bigTool(4, "d".repeat(1000))]);
  const r = await run({ tool: "big_tool" });
  assert.equal(r.description.length, 1000);
  assert.match(r.how_to_call, /PAID/);
});

test("profile details: over the cap the prose shrinks first and the schema stays whole", async () => {
  // schema ~10 KB + 4 KB description + how_to_call: over 14 000 only because of the prose
  const { raw, run } = await profileTool(() => [bigTool(10)]);
  const s = await raw({ tool: "big_tool" });
  assert.ok(s.length <= 14_000, String(s.length));
  const r = await run({ tool: "big_tool" });
  assert.ok(r.description.length <= 301);
  assert.doesNotMatch(r.how_to_call, /PAID/);
  assert.match(r.how_to_call, /workspace paths/);
  assert.equal(Object.keys(r.schema.properties).length, Object.keys(bigTool(10).inputSchema.properties).length - 1);
});

test("profile details: a 64 KB schema is never cut — the cap grows for that reply", async () => {
  const { raw } = await profileTool(() => [bigTool(64)]);
  const s = await raw({ tool: "big_tool" });
  assert.ok(s.length > 64 * 1024);
  assert.doesNotMatch(s, /…\(truncated\)/);
  const r = JSON.parse(s);
  const want = bigTool(64).inputSchema;
  delete want.properties.schema_revision;
  want.required = [];
  assert.deepEqual(r.schema, want);
  assert.ok(r.description.length <= 301);
});

// ---------- profile mode: instructions and the routing guide ----------

// the fixture's identities: write_text → id 1 (no visual id), masked_edit → masked-edit (7), styled_portrait → styled-portrait (12)
const PGUIDE = {
  rules: ["profile rule"],
  workflows: {
    "masked-edit": { use_for: "edit part of an image", knobs: "the mask", caveats: "PNG masks only" },
    "styled-portrait": { use_for: "character cards", knobs: "style", caveats: "no text" },
    "id:1": { use_for: "short texts" },
    "id:12": { use_for: "never shown: the visual id wins" },
    gone: { use_for: "not in this profile" },
  },
  routes: [
    { task: "character card", pick: ["gone", "styled-portrait", "masked-edit"] },
    { task: "copy", pick: ["id:1"] },
    { task: "dead route", pick: ["gone"] },
  ],
};
const STUDIO_TEXT = "Use styled_portrait for every character card.";
const withInstructions = (text) => () => ({ protocolVersion: "2025-06-18", instructions: text });

test("profile guide list: instructions, recommended by tool names, rules, use_for and the precedence hint", async () => {
  const { run, inits } = await profileTool(undefined, {
    guide: PGUIDE,
    init: withInstructions(`${STUDIO_TEXT}\nEach workflow tool call starts one paid generation; check the price first.`),
  });
  const r = await run({});
  assert.deepEqual(Object.keys(r), ["instructions", "recommended", "rules", "tools", "hint"]);
  assert.equal(r.instructions, STUDIO_TEXT);
  assert.deepEqual(r.recommended, [
    {
      task: "character card",
      tools: [
        { tool: "styled_portrait", title: "Styled portrait", why: "character cards" },
        { tool: "masked_edit", title: "masked_edit", why: "edit part of an image" },
      ],
    },
    { task: "copy", tools: [{ tool: "write_text", title: "write_text", why: "short texts" }] },
  ]);
  assert.deepEqual(r.rules, ["profile rule"]);
  const byName = Object.fromEntries(r.tools.map((t) => [t.tool, t]));
  assert.equal(byName.styled_portrait.use_for, "character cards");
  assert.equal(byName.write_text.use_for, "short texts");
  assert.deepEqual(Object.keys(byName.masked_edit), ["tool", "title", "category", "description", "use_for", "required", "file_args"]);
  // the 200-char description cut stays, use_for comes alongside it
  assert.ok(byName.masked_edit.description.length <= 200);
  assert.match(r.hint, /studio's instructions and each tool's own description take precedence over the generic guide/);
  // cached: one initialize per TTL
  await run({});
  assert.equal(inits(), 1);
});

test("profile guide list: a tool without _meta gets no use_for and is never recommended", async () => {
  const bare = { name: "bare_tool", title: "styled-portrait", inputSchema: { type: "object", properties: { schema_revision: { type: "string", enum: ["r1"] } }, required: ["schema_revision"] } };
  const { run } = await profileTool(() => [bare], { guide: PGUIDE });
  const r = await run({});
  assert.equal("use_for" in r.tools[0], false);
  assert.equal("recommended" in r, false);
  assert.deepEqual(r.rules, ["profile rule"]);
});

test("profile guide list: query filters recommended (by task and by tool name) and drops rules", async () => {
  const { run } = await profileTool(undefined, { guide: PGUIDE });
  const byTask = await run({ query: "character" });
  assert.equal("rules" in byTask, false);
  assert.deepEqual(byTask.recommended.map((x) => [x.task, x.tools.map((t) => t.tool)]), [["character card", ["styled_portrait", "masked_edit"]]]);
  // no row matches the task's words, yet recommended does: the usual hint, precedence included
  assert.deepEqual(byTask.tools, []);
  assert.match(byTask.hint, /call loremax_workflows with tool .* take precedence over the generic guide/);
  const byTool = await run({ query: "masked_" });
  assert.deepEqual(byTool.recommended.map((x) => [x.task, x.tools.map((t) => t.tool)]), [["character card", ["masked_edit"]]]);
  assert.deepEqual(byTool.tools.map((t) => t.tool), ["masked_edit"]);
  const none = await run({ query: "nothing-like-this" });
  assert.deepEqual(Object.keys(none), ["instructions", "tools", "hint"]);
});

test("profile guide list: a failed initialize gives instructions null, the list intact, and is retried next call", async () => {
  let fail = true;
  const { run, rec, inits } = await profileTool(undefined, {
    guide: PGUIDE,
    init: () => (fail ? new Response("boom", { status: 500 }) : { instructions: STUDIO_TEXT }),
  });
  const r = await run({});
  assert.equal(r.instructions, null);
  assert.deepEqual(r.tools.map((t) => t.tool), ["write_text", "masked_edit", "styled_portrait"]);
  assert.ok(r.recommended.length);
  assert.ok(rec.logs.some((l) => l.level === "warn" && /initialize/.test(l.msg)));
  fail = false;
  assert.equal((await run({})).instructions, STUDIO_TEXT);
  assert.equal(inits(), 2);
});

test("profile guide list: a dead profile is still the catalog's error", async () => {
  const f = mockFetch([["POST", `/api/mcp/s/${PROFILE}`, () => new Response("gone", { status: 404 })]]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  await activate(ctx, { guide: PGUIDE });
  await assert.rejects(rec.tools.get("loremax_workflows").handler({}, {}), /404/);
});

test("profile guide details: guide by visual id (beats id:<n>) and by numeric id; none when unmatched; no initialize", async () => {
  const { run, inits } = await profileTool(undefined, { guide: PGUIDE, init: withInstructions(STUDIO_TEXT) });
  const masked = await run({ tool: "masked_edit" });
  assert.deepEqual(Object.keys(masked), ["tool", "title", "description", "guide", "schema", "file_args", "limits", "how_to_call"]);
  assert.deepEqual(masked.guide, { use_for: "edit part of an image", knobs: "the mask", caveats: "PNG masks only" });
  assert.equal((await run({ tool: "styled_portrait" })).guide.use_for, "character cards");
  assert.deepEqual((await run({ tool: "write_text" })).guide, { use_for: "short texts" });
  const plain = await (await profileTool()).run({ tool: "masked_edit" });
  assert.equal("guide" in plain, false);
  assert.equal(inits(), 0);
});

test("profile guide details: over the cap the guide goes first, the description and schema stay whole", async () => {
  const guide = { rules: [], routes: [], workflows: { "big-tool": { use_for: "big things", knobs: "k", caveats: "c".repeat(6000) } } };
  // schema ~8 KB + 1 KB description: under the cap without the guide, over it with the guide
  const { raw, run } = await profileTool(() => [bigTool(8, "d".repeat(1000), { meta: true })], { guide });
  const s = await raw({ tool: "big_tool" });
  assert.ok(s.length <= 14_000, String(s.length));
  const r = JSON.parse(s);
  assert.equal("guide" in r, false);
  assert.equal(r.description.length, 1000);
  assert.match(r.how_to_call, /PAID/);
  assert.equal(Object.keys(r.schema.properties).length, Object.keys(bigTool(8).inputSchema.properties).length - 1);
  // a small schema keeps the same guide
  const small = await (await profileTool(() => [bigTool(1, "d", { meta: true })], { guide })).run({ tool: "big_tool" });
  assert.equal(small.guide.use_for, "big things");
});

test("profile guide details: a 64 KB schema drops the guide and is never cut", async () => {
  const guide = { rules: [], routes: [], workflows: { "big-tool": { use_for: "big things" } } };
  const { raw } = await profileTool(() => [bigTool(64, undefined, { meta: true })], { guide });
  const s = await raw({ tool: "big_tool" });
  assert.doesNotMatch(s, /…\(truncated\)/);
  const r = JSON.parse(s);
  assert.equal("guide" in r, false);
  assert.ok(r.description.length <= 301);
  const want = bigTool(64).inputSchema;
  delete want.properties.schema_revision;
  want.required = [];
  assert.deepEqual(r.schema, want);
});
