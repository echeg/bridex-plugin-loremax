import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, fakeSleep } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const REMOTE = "https://static.studio.example.com/files/cad-clean.png";
const CALL = { workspace: "studio", agent: "art", taskId: "test" };
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));
let restore = () => {};
afterEach(() => restore());

async function setup({ profile = false, onCall } = {}) {
  globalThis[Symbol.for("bridex.loremax.uploads")]?.clear();
  globalThis[Symbol.for("bridex.loremax.submitting")]?.clear();
  const s = fakeCtx({ config: { api_key: "lmx_prod_test", base_url: BASE, ...(profile ? { profile_url: PROFILE } : {}) } });
  const clock = { t: 1000 };
  const time = fakeSleep(clock);
  await activate(s.ctx, { now: () => clock.t, sleep: time.sleep });
  let seq = 0;
  const assets = new Map();
  const rpc = async (m) => {
    if (m.method === "tools/list") return { ...FIXTURE, id: m.id };
    const { name, arguments: args } = m.params;
    const custom = await onCall?.(name, args, clock);
    if (custom) return { jsonrpc: "2.0", id: m.id, ...custom };
    let data;
    if (name === "request_upload_url") {
      const id = `asset-${++seq}`;
      assets.set(id, args.media_type);
      data = { asset_id: id, upload_url: `https://r2.test/put/${id}`, headers: { "Content-Type": args.mime } };
    } else if (name === "finalize_upload") {
      data = { url: `https://content.test/uploads/${args.asset_id}`, media_type: assets.get(args.asset_id) };
    } else if (name === "upload_from_url") {
      data = { url: `https://content.test/uploads/import-${++seq}.png`, media_type: "image" };
    } else if (name === "get_workflow_details") {
      data = { id: 337, visual_id: "i2i_gpt_image_2.5", input_fields: [{ key: "image_url", type: "slots_input_media" }] };
    } else if (name === "get_pricing") {
      data = { tokenCost: 10 };
    } else if (name === "masked_edit") {
      data = { generationId: ++seq + 500, status: "completed", tokensCost: 10, text_content: "done" };
    } else throw new Error(`Unexpected MCP tool: ${name}`);
    return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
  };
  const f = mockFetch([
    ["POST", /\/api\/mcp(?:\/s\/[A-Za-z0-9]+)?$/, async (req) => jsonResponse(Array.isArray(req.json) ? await Promise.all(req.json.map(rpc)) : await rpc(req.json))],
    ["PUT", "https://r2.test/put/", () => new Response(null, { status: 200 })],
    ["POST", "/api/v2/workflow/execute", () => ({ generationId: 501, status: "pending", tokensCost: 10 })],
    ["POST", "/api/v2/generations/501/check", () => ({ status: "completed", result: { textContent: "done" } })],
  ]);
  restore = f.restore;
  const run = async (name, args) => JSON.parse((await s.rec.tools.get(name).handler(args, CALL)).content[0].text);
  const write = (rel, contents = "PNG") => {
    const abs = rel.startsWith("artifacts/")
      ? path.join(s.ctx.paths.workspaceArtifacts(CALL.workspace), rel.slice(10))
      : path.join(s.ctx.paths.workspaceWorkdir(CALL.workspace), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    return abs;
  };
  const sent = () => f.calls.filter((c) => c.url.includes("/api/mcp")).flatMap((c) => Array.isArray(c.json) ? c.json : [c.json]);
  return { ...s, f, clock, run, write, sent };
}

test("upload → workflow 337: five ordered references reach both named and generic inputs", async () => {
  const s = await setup();
  const detail = await s.run("loremax_workflows", { workflow_id: "337" });
  assert.match(detail.reference_usage, /does NOT fill named slots/);
  assert.deepEqual(detail.reference_example.inputs, { image_url: ["<uploaded-url>"], image_urls: ["<uploaded-url>"], slots_image_count: 1 });
  const sources = Array.from({ length: 5 }, (_, i) => `artifacts/ref-${i}.png`);
  sources.forEach((source, i) => s.write(source, `PNG ${i}`));
  const uploaded = await s.run("loremax_upload", { sources });
  assert.deepEqual(uploaded.files.map((f) => f.source), sources);
  assert.equal(new Set(uploaded.urls).size, 5);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.rec.usage.length, 0);
  const inputs = {
    gen_count: 1, model: "Sunburst", image_size_width: 3840, image_size_height: 2883,
    quality: "high", background: "transparent", prompt: "Follow the reference scene",
    image_url: uploaded.urls, image_urls: uploaded.urls, slots_image_count: uploaded.urls.length,
  };
  const done = await s.run("loremax_generate", { workflow_id: "337", inputs });
  assert.equal(done.status, "completed");
  const execute = s.f.calls.find((c) => c.url.endsWith("/workflow/execute"));
  assert.deepEqual(execute.json, { workflowId: "337", inputs });
  assert.equal(execute.headers["content-type"], "application/json");
  assert.equal(s.rec.usage.length, 1);
});

for (const profile of [false, true]) test(`upload imports Bridex HTTPS URLs in ${profile ? "profile" : "REST"} mode; preserves mixed order and duplicates`, async () => {
  const s = await setup({ profile });
  s.write("ref.png");
  s.write("copy.png");
  const sources = [REMOTE, "ref.png", REMOTE, "copy.png"];
  const out = await s.run("loremax_upload", { sources });
  assert.deepEqual(out.files.map((f) => f.source), sources);
  assert.equal(out.urls[0], out.urls[2]);
  assert.equal(out.urls[1], out.urls[3]);
  assert.notEqual(out.urls[0], REMOTE);
  const calls = s.sent();
  assert.equal(calls.filter((m) => m.params.name === "request_upload_url").length, 1);
  assert.deepEqual(calls.filter((m) => m.params.name === "upload_from_url").map((m) => m.params.arguments), [{ url: REMOTE }]);
  const target = profile ? `${BASE}/api/mcp/s/${PROFILE}` : `${BASE}/api/mcp`;
  for (const req of s.f.calls.filter((c) => c.method === "POST")) {
    assert.equal(req.url, target);
    assert.equal(req.headers.authorization, "Bearer lmx_prod_test");
  }
  const put = s.f.calls.find((c) => c.method === "PUT");
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.headers["x-api-key"], undefined);
  assert.ok(!s.f.calls.some((c) => c.url === REMOTE));
  assert.equal(s.jobs.length, 0);
  assert.equal(s.rec.usage.length, 0);
});

test("profile: uploaded URL works as a named argument; local generation reuses the same upload cache", async () => {
  const s = await setup({ profile: true });
  s.write("ref.png");
  const uploaded = await s.run("loremax_upload", { sources: ["ref.png"] });
  await s.run("loremax_generate", { tool: "masked_edit", arguments: { text: "first", source: uploaded.urls[0] } });
  await s.run("loremax_generate", { tool: "masked_edit", arguments: { text: "second", source: "ref.png" } });
  assert.equal(s.sent().filter((m) => m.params?.name === "request_upload_url").length, 1);
  for (const m of s.sent().filter((m) => m.params?.name === "masked_edit")) assert.equal(m.params.arguments.source, uploaded.urls[0]);
});

test("upload validates sources, workspace boundaries, media type and size before HTTP", async () => {
  const s = await setup();
  s.write("ref.png");
  const big = s.write("big.png", "");
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  for (const args of [
    { sources: [] }, { sources: Array(21).fill("ref.png") }, { sources: [null] },
    { sources: ["https://", "ref.png"] }, { sources: ["http://example.com/ref.png"] },
    { sources: ["https://user:pass@example.com/ref.png"] },
    { sources: [REMOTE, "../../outside.png"] }, { sources: [REMOTE, "missing.png"] },
    { sources: ["ref.png"], media_type: "nope" }, { sources: ["big.png"] },
  ]) await assert.rejects(s.run("loremax_upload", args), (e) => e.charged === false && /nothing was charged/.test(e.message));
  assert.equal(s.f.calls.length, 0);
});

test("upload type override handles audio mp4; a remote type mismatch starts no generation", async () => {
  const s = await setup();
  s.write("voice.mp4", "audio");
  const out = await s.run("loremax_upload", { sources: ["voice.mp4"], media_type: "audio" });
  assert.equal(out.files[0].media_type, "audio");
  assert.equal(s.sent()[0].params.arguments.mime, "audio/mp4");
  await assert.rejects(s.run("loremax_upload", { sources: [REMOTE], media_type: "video" }), /imported image, expected video.*nothing was charged/);
  assert.equal(s.jobs.length, 0);
});

test("import failure and expired upload budget stop before a generation", async () => {
  const s = await setup({ onCall: (name, args, clock) => {
    if (name !== "upload_from_url") return;
    if (args.url.endsWith("bad.png")) return { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Fetch failed: HTTP 403" }) }] } };
    clock.t += 50_001;
  } });
  await assert.rejects(s.run("loremax_upload", { sources: ["https://static.example.com/bad.png"] }), /HTTP 403.*nothing was charged/);
  await assert.rejects(s.run("loremax_upload", { sources: [REMOTE, "https://static.example.com/next.png"] }), (e) => e.deadline && e.charged === false);
  assert.equal(s.sent().length, 2);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.rec.usage.length, 0);
});

test("REST reference URL misuse points to upload and named inputs before the paid call", async () => {
  const s = await setup();
  await assert.rejects(s.run("loremax_generate", { workflow_id: "337", inputs: {}, references: [REMOTE] }), /loremax_upload.*inputs.*nothing was charged/);
  assert.equal(s.f.calls.length, 0);
});
