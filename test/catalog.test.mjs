import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createClient, createProfileCatalog } from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));
const fixtureTools = () => structuredClone(FIXTURE.result.tools);

let restore = () => {};
afterEach(() => restore());

/** A catalog on a fake clock whose profile answers tools/list with `tools()` (re-evaluated per request). */
function setup(tools = fixtureTools) {
  const f = mockFetch([[
    "POST",
    `/api/mcp/s/${PROFILE}`,
    (req) => jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: { tools: tools() } }),
  ]]);
  restore = f.restore;
  const clock = { t: 1_000_000 };
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  const lmx = createClient(ctx, { now: () => clock.t });
  const catalog = createProfileCatalog(lmx, { now: () => clock.t, log: ctx.log });
  const lists = () => f.calls.filter((c) => c.json?.method === "tools/list").length;
  return { catalog, clock, rec, f, lists };
}

test("catalog: tools/list on the profile path with Bearer; generation and service tools split", async () => {
  const { catalog, f } = setup();
  const c = await catalog.get();
  assert.equal(f.calls[0].url, `${BASE}/api/mcp/s/${PROFILE}`);
  assert.equal(f.calls[0].headers.authorization, "Bearer lmx_prod_k");
  assert.equal(f.calls[0].json.method, "tools/list");
  assert.deepEqual([...c.tools.keys()], ["write_text", "masked_edit", "styled_portrait"]);
  assert.deepEqual(c.service, ["get_balance", "check_generation", "request_upload_url", "finalize_upload", "upload_from_url"]);
});

test("catalog: a tool without _meta but with schema_revision is a generation tool; a service name never is", async () => {
  const extra = [
    { name: "bare_tool", title: "Bare tool", inputSchema: { type: "object", properties: { prompt: { type: "string" }, schema_revision: { type: "string", enum: ["r1"] } }, required: ["schema_revision", "prompt"] } },
    // a service tool stays one even if its schema grows a schema_revision
    { name: "get_balance", inputSchema: { type: "object", properties: { schema_revision: { type: "string", enum: ["x"] } } } },
    // _meta alone does not make a generation tool
    { name: "meta_only", inputSchema: { type: "object", properties: { q: { type: "string" } } }, _meta: { "loremax.ai/workflow": { version: 1, workflowId: 99, title: "Meta" } } },
  ];
  const { catalog, rec } = setup(() => [...fixtureTools().filter((t) => t.name !== "get_balance"), ...extra]);
  const c = await catalog.get();
  assert.ok(c.tools.has("bare_tool"));
  assert.ok(!c.tools.has("get_balance") && c.service.includes("get_balance"));
  assert.ok(!c.tools.has("meta_only") && c.service.includes("meta_only"));
  const bare = c.tools.get("bare_tool");
  assert.deepEqual(bare.identity, { title: "Bare tool" });
  assert.equal(bare.title, "Bare tool");
  assert.equal(bare.revision, "r1");
  assert.equal(rec.logs.filter((l) => l.level === "warn" && /bare_tool has no _meta/.test(l.msg)).length, 1);
  // the fallback is logged once, not on every refresh
  await catalog.get({ force: true });
  assert.equal(rec.logs.filter((l) => /bare_tool has no _meta/.test(l.msg)).length, 1);
});

test("catalog: identity falls back to the tool name when there is neither _meta nor title", async () => {
  const { catalog } = setup(() => [{ name: "nameless", inputSchema: { type: "object", properties: { schema_revision: { enum: ["r"] } } } }]);
  const t = (await catalog.get()).tools.get("nameless");
  assert.deepEqual(t.identity, { title: "nameless" });
  assert.equal(t.title, "nameless");
  assert.equal(t.description, "");
});

test("catalog: revision is enum[0]; schema_revision, api_key and on_behalf_of are stripped; vendor keys kept", async () => {
  const { catalog } = setup();
  const c = await catalog.get();
  const text = c.tools.get("write_text");
  assert.equal(text.revision, "ed28c0a088869cd4b2bb04358ed7c367a2d0fdb46103078fcd3e11a7d22a14f8");
  assert.deepEqual(Object.keys(text.agentSchema.properties), ["text"]);
  assert.deepEqual(text.agentSchema.required, ["text"]);
  assert.equal(text.agentSchema.additionalProperties, false);
  const masked = c.tools.get("masked_edit");
  assert.deepEqual(Object.keys(masked.agentSchema.properties), ["text", "source", "edit_mask"]);
  assert.deepEqual(masked.agentSchema.required, ["text", "source"]);
  assert.equal(masked.agentSchema["x-loremax-conditions"].version, 1);
  assert.equal(masked.agentSchema["x-loremax-limits"].maxTotalBytes, 209715200);
  assert.equal(masked.agentSchema.properties.source["x-loremax-media"].mediaType, "image");
  // a controller's exact rules stay with the schema the agent reads
  const styled = c.tools.get("styled_portrait");
  assert.deepEqual(styled.agentSchema.required, []);
  assert.ok(styled.agentSchema["x-loremax-conditions"].allOf.length === 2);
});

test("catalog: agentSchema is a copy — editing it leaves the reply untouched", async () => {
  const raw = fixtureTools();
  const { catalog } = setup(() => raw);
  const t = (await catalog.get()).tools.get("write_text");
  assert.ok(raw[0].inputSchema.properties.schema_revision, "the source entry keeps schema_revision");
  t.agentSchema.properties.text.maxLength = 1;
  assert.equal(raw[0].inputSchema.properties.text.maxLength, 100);
});

test("catalog: fileArgs from x-loremax-media and limits from the root x-loremax-limits", async () => {
  const { catalog } = setup();
  const c = await catalog.get();
  assert.deepEqual(c.tools.get("write_text").fileArgs, []);
  assert.equal(c.tools.get("write_text").limits, null);
  const masked = c.tools.get("masked_edit");
  assert.deepEqual(masked.fileArgs, [
    { name: "source", mediaType: "image", role: "source", cardinality: "single", acceptedFormats: ["png", "jpg", "jpeg", "webp"], constraints: { maxFileSizeMb: 50 } },
    { name: "edit_mask", mediaType: "image", role: "mask", cardinality: "single", acceptedFormats: ["png"], constraints: { maxFileSizeMb: 50 }, pairedWith: { key: "source", index: 0 } },
  ]);
  assert.deepEqual(masked.limits, { version: 1, maxImagePositions: 50, maxMediaPositions: 100, maxTotalBytes: 209715200 });
  assert.deepEqual(c.tools.get("styled_portrait").fileArgs, [
    { name: "references", mediaType: "image", role: "source", cardinality: "array", acceptedFormats: ["png", "jpg", "jpeg", "webp"], constraints: { maxFileSizeMb: 20, minWidth: 256 } },
  ]);
});

test("catalog: identity, title and description come from _meta and the entry", async () => {
  const { catalog } = setup();
  const c = await catalog.get();
  assert.deepEqual(c.tools.get("masked_edit").identity, { workflowId: 7, visualId: "masked-edit", title: "masked_edit", category: "Image", contentType: "image", pipeline: false });
  const s = c.tools.get("styled_portrait");
  assert.equal(s.title, "Styled portrait");
  assert.equal(s.identity.pipeline, true);
  assert.equal(s.identity.category, "Portraits");
  assert.match(s.description, /style controller/);
  assert.deepEqual(c.tools.get("write_text").identity, { workflowId: 1, visualId: null, title: "write_text", category: "Text", contentType: "text", pipeline: false });
});

test("catalog: an unknown x-loremax-media version is a plain URL argument, logged once", async () => {
  const tools = () => {
    const t = fixtureTools();
    const masked = t.find((x) => x.name === "masked_edit");
    masked.inputSchema.properties.source["x-loremax-media"].version = 2;
    masked.inputSchema.properties.edit_mask["x-loremax-media"].version = 2;
    return t;
  };
  const { catalog, rec } = setup(tools);
  const masked = (await catalog.get()).tools.get("masked_edit");
  assert.deepEqual(masked.fileArgs, []);
  assert.ok(masked.agentSchema.properties.source, "the argument itself stays in the schema");
  await catalog.get({ force: true });
  assert.equal(rec.logs.filter((l) => l.level === "warn" && /x-loremax-media version 2 is unknown/.test(l.msg)).length, 1);
});

test("catalog: cached for ~10 min; force and an expired TTL reread tools/list", async () => {
  const { catalog, clock, lists } = setup();
  const a = await catalog.get();
  clock.t += 9 * 60_000;
  assert.equal(await catalog.get(), a);
  assert.equal(lists(), 1);
  await catalog.get({ force: true });
  assert.equal(lists(), 2);
  clock.t += 10 * 60_000 + 1;
  await catalog.get();
  assert.equal(lists(), 3);
});

test("catalog: concurrent gets share one tools/list", async () => {
  const { catalog, lists } = setup();
  const [a, b] = await Promise.all([catalog.get(), catalog.get({ force: true })]);
  assert.equal(a, b);
  assert.equal(lists(), 1);
});

test("catalog: refreshAfter marks the cache stale only for the refresh codes", async () => {
  const { catalog, lists } = setup();
  await catalog.get();
  for (const code of ["INVALID_WORKFLOW_INPUT", "MEDIA_INPUT_INVALID", "INSUFFICIENT_TOKENS", undefined]) {
    assert.equal(catalog.refreshAfter(Object.assign(new Error("x"), { code })), false);
  }
  assert.equal(catalog.refreshAfter(null), false);
  await catalog.get();
  assert.equal(lists(), 1);
  for (const code of ["SCHEMA_REVISION_MISMATCH", "WORKFLOW_UNAVAILABLE", "TOOL_NOT_FOUND"]) {
    assert.equal(catalog.refreshAfter(Object.assign(new Error("x"), { code })), true);
    await catalog.get();
  }
  assert.equal(lists(), 4);
});

test("catalog: refreshAfter before any load is harmless", async () => {
  const { catalog, lists } = setup();
  assert.equal(catalog.refreshAfter({ code: "TOOL_NOT_FOUND" }), true);
  await catalog.get();
  assert.equal(lists(), 1);
});

test("catalog: a refresh picks up a new revision", async () => {
  let rev = "rev-1";
  const { catalog } = setup(() => [{ name: "t", inputSchema: { type: "object", properties: { schema_revision: { enum: [rev] } } } }]);
  assert.equal((await catalog.get()).tools.get("t").revision, "rev-1");
  rev = "rev-2";
  catalog.refreshAfter({ code: "SCHEMA_REVISION_MISMATCH" });
  assert.equal((await catalog.get()).tools.get("t").revision, "rev-2");
});

test("catalog: malformed entries are skipped, never thrown", async () => {
  const junk = [
    null,
    42,
    "write_text",
    [],
    {},
    { name: "" },
    { name: 7, inputSchema: { properties: { schema_revision: { enum: ["r"] } } } },
    { name: "no_schema" },
    { name: "props_not_object", inputSchema: { properties: [] } },
    { name: "no_revision_value", inputSchema: { type: "object", properties: { schema_revision: { type: "string" } } } },
    { name: "revision_not_string", inputSchema: { type: "object", properties: { schema_revision: { enum: [5] } } } },
    { name: "weird_media", inputSchema: { type: "object", properties: { schema_revision: { enum: ["r"] }, img: { type: "string", "x-loremax-media": "nope" }, other: null, req: 1 }, required: "x" } },
    { name: "bad_meta", _meta: { "loremax.ai/workflow": "x" }, inputSchema: { type: "object", properties: { schema_revision: { enum: ["r"] } } } },
  ];
  const { catalog, rec } = setup(() => [...junk, ...fixtureTools()]);
  const c = await catalog.get();
  assert.deepEqual([...c.tools.keys()], ["weird_media", "bad_meta", "write_text", "masked_edit", "styled_portrait"]);
  assert.deepEqual(c.tools.get("weird_media").fileArgs, []);
  assert.equal(c.tools.get("weird_media").agentSchema.required, "x");
  assert.deepEqual(c.tools.get("bad_meta").identity, { title: "bad_meta" });
  // unusable generation tools are neither generation nor service tools
  assert.ok(!c.service.includes("no_revision_value") && !c.service.includes("revision_not_string"));
  assert.ok(rec.logs.some((l) => l.level === "warn" && /no_revision_value is unreadable/.test(l.msg)));
  // nameless or non-object entries are dropped silently; the rest of the catalog is intact
  assert.ok(c.service.includes("no_schema") && c.service.includes("props_not_object"));
});

test("catalog: a reply without result.tools is an empty catalog", async () => {
  const f = mockFetch([["POST", `/api/mcp/s/${PROFILE}`, (req) => jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: { tools: "nope" } })]]);
  restore = f.restore;
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  const c = await createProfileCatalog(createClient(ctx)).get();
  assert.equal(c.tools.size, 0);
  assert.deepEqual(c.service, []);
});

test("catalog: follows nextCursor pages", async () => {
  const tools = fixtureTools();
  const f = mockFetch([["POST", `/api/mcp/s/${PROFILE}`, (req) => jsonResponse({
    jsonrpc: "2.0",
    id: req.json.id,
    result: req.json.params?.cursor === "p2" ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "p2" },
  })]]);
  restore = f.restore;
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  const c = await createProfileCatalog(createClient(ctx)).get();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].json.params, undefined);
  assert.deepEqual([...c.tools.keys()], ["write_text", "masked_edit", "styled_portrait"]);
});

test("catalog: a JSON-RPC error or a 404 profile throws and caches nothing", async () => {
  let mode = "rpc-error";
  const f = mockFetch([["POST", `/api/mcp/s/${PROFILE}`, (req) =>
    mode === "rpc-error" ? jsonResponse({ jsonrpc: "2.0", id: req.json.id, error: { code: -32603, message: "boom" } })
      : mode === "404" ? new Response("not found", { status: 404 })
        : jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: { tools: fixtureTools() } })]]);
  restore = f.restore;
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  const catalog = createProfileCatalog(createClient(ctx));
  await assert.rejects(catalog.get(), /tools\/list: boom/);
  mode = "404";
  await assert.rejects(catalog.get(), (e) => e.code === "PROFILE_NOT_FOUND");
  mode = "ok";
  assert.equal((await catalog.get()).tools.size, 3);
});
