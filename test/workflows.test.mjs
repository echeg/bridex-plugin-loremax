import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult, mcpError } from "./helpers.mjs";

const BASE = "https://lm.test";
const tool = async () => {
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  await activate(ctx);
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
afterEach(() => restore());

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
