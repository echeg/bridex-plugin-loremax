import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult, fakeSleep, eventually, generationRows } from "./helpers.mjs";

const BASE = "https://lm.test";
const CDN = "https://cdn.lm.test";
const CALL = { workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: "run-1" };

/**
 * activate with a fake clock: each /check advances it by `tick` ms and so does every sleep,
 * so wait_s runs out without real waiting; time.expire() ends the submission's budget race.
 */
const setup = async ({ config = {}, tick = 1_000, patch } = {}) => {
  const f = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, ...config } });
  patch?.(f.ctx);
  const clock = { t: 0, tick };
  const time = fakeSleep(clock);
  const seam = await activate(f.ctx, { pollMs: 1, now: () => clock.t, sleep: time.sleep });
  const t = f.rec.tools.get("loremax_generate");
  const run = async (args, call = CALL) => JSON.parse((await t.handler(args, call)).content[0].text);
  const art = f.ctx.paths.workspaceArtifacts(CALL.workspace);
  const put = (rel, bytes) => {
    const abs = path.join(art, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  };
  const gens = () => generationRows(f.jobs);
  const placeholders = () => f.jobs.filter((j) => String(j.externalId).startsWith("submit:"));
  return { ...f, clock, time, run, tool: t, art, put, gens, placeholders, watchOnce: seam.watchOnce };
};

const EXECUTE = { generationId: 501, status: "pending", tokensCost: 12, checkStatusUrl: "/api/v2/generations/501/check", jobId: "j", async: true };
const DONE = { status: "completed", result: { originalUrls: [`${CDN}/out.png`], previewUrls: [], contentTypes: ["image/png"] } };

/** /check replies in order (the last one repeats); each call advances the fake clock. */
const checkRoute = (s, replies) => {
  let i = 0;
  return ["POST", "/api/v2/generations/501/check", () => {
    s.clock.t += s.clock.tick;
    return replies[Math.min(i++, replies.length - 1)];
  }];
};

let restore = () => {};
afterEach(() => restore());

test("registers loremax_generate as a paid tool", async () => {
  const s = await setup();
  assert.match(s.tool.description, /PAID/);
  assert.match(s.tool.description, /WOKEN/);
  assert.match(s.tool.description, /loremax_workflows/);
});

test("JSON path: execute, poll until completed, save, annotate, usage, settle", async () => {
  const s = await setup({ config: { usd_per_token: 0.01 } });
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [{ status: "pending" }, { status: "checking" }, DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const reply = await s.run({ workflow_id: "flux-portrait", inputs: { prompt: "a knight in rain", seed: 3 }, note: "hero" });

  const exec = f.calls[0];
  assert.equal(exec.url, `${BASE}/api/v2/workflow/execute`);
  assert.equal(exec.headers["x-api-key"], "lmx_prod_k");
  assert.equal(exec.headers["content-type"], "application/json");
  assert.deepEqual(exec.json, { workflowId: "flux-portrait", inputs: { prompt: "a knight in rain", seed: 3 } });
  assert.equal(f.calls.filter((c) => c.url.endsWith("/check")).length, 3);

  assert.deepEqual(reply, {
    generation_id: "501",
    status: "completed",
    workflow: "flux-portrait",
    artifacts: ["task-9/flux-portrait-501.png"],
    tokens_cost: 12,
    cost_usd: 0.12,
    hint: "reference outputs as [media: artifacts/<path>]",
  });
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/flux-portrait-501.png"), "utf8"), "PNG");

  const g = s.rec.annotate[0].meta.generation;
  assert.equal(g.provider, "LoreMax");
  assert.equal(g.workflow, "flux-portrait");
  assert.deepEqual(g.params, { prompt: "a knight in rain", seed: 3 });
  assert.equal(g.externalId, "501");
  assert.equal(s.rec.annotate[0].meta.description, "LoreMax flux-portrait · generation 501 · hero");
  assert.equal(s.rec.usage[0].units, 12);
  assert.equal(s.rec.usage[0].unit, "tk");
  assert.equal(s.rec.usage[0].ref, "501");

  assert.equal(s.gens().length, 1);
  const j = s.gens()[0];
  assert.equal(j.externalId, "501");
  assert.equal(j.model, "flux-portrait");
  // the token spend rides in the label so a restart does not lose it
  assert.equal(j.label, "hero · 12 tk");
  assert.equal(j.taskId, "task-9");
  assert.equal(j.sessionKey, "sess-1");
  assert.equal(j.runId, "run-1");
  assert.equal(j.status, "succeeded");
  assert.deepEqual(j.result, { workspace: "studio", artifacts: ["task-9/flux-portrait-501.png"], tokensCost: 12 });
});

test("multipart path: references go as file_<i> blobs, params carry image_urls", async () => {
  const s = await setup();
  s.put("studio-references/knight.png", "K");
  fs.mkdirSync(s.ctx.paths.workspaceWorkdir("studio"), { recursive: true });
  fs.writeFileSync(path.join(s.ctx.paths.workspaceWorkdir("studio"), "castle.jpg"), "CC");
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG")],
  ]);
  restore = f.restore;
  const refs = ["artifacts/studio-references/knight.png", "castle.jpg"];
  await s.run({ workflow_id: "12", inputs: { prompt: "the knight at the castle" }, references: refs });

  const body = f.calls[0].body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("workflowId"), "12");
  assert.deepEqual(JSON.parse(body.get("inputs")), { prompt: "the knight at the castle" });
  assert.equal(body.get("fileCount"), "2");
  const f0 = body.get("file_0");
  const f1 = body.get("file_1");
  assert.equal(f0.name, "knight.png");
  assert.equal(f0.type, "image/png");
  assert.equal(await f0.text(), "K");
  assert.equal(f1.name, "castle.jpg");
  assert.equal(f1.type, "image/jpeg");
  // the boundary is fetch's job: no hand-set Content-Type
  assert.equal(f.calls[0].headers["content-type"], undefined);

  const g = s.rec.annotate[0].meta.generation;
  assert.deepEqual(g.params, { prompt: "the knight at the castle", image_urls: refs });
  // no note → the prompt labels the job
  assert.equal(s.gens()[0].label, "the knight at the castle · 12 tk");
});

test("a reference outside the workspace throws before any HTTP call", async () => {
  const s = await setup();
  fs.writeFileSync(path.join(s.dir, "outside.png"), "x");
  const f = mockFetch([]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "12", inputs: {}, references: ["../../outside.png"] }), /outside your workspace/);
  await assert.rejects(s.run({ workflow_id: "12", inputs: {}, references: ["artifacts/missing.png"] }), /file not found/);
  assert.equal(f.calls.length, 0);
  assert.equal(s.gens().length, 0);
});

test("a reference over 20MB throws before any HTTP call", async () => {
  const s = await setup();
  s.put("big.png", Buffer.alloc(20 * 1024 * 1024 + 1));
  const f = mockFetch([]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "12", inputs: {}, references: ["artifacts/big.png"] }), /up to 20MB/);
  assert.equal(f.calls.length, 0);
});

test("timeout: in_progress with the generation id, job stays tracked", async () => {
  const s = await setup({ tick: 5_000 });
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [{ status: "pending" }]),
  ]);
  restore = f.restore;
  const reply = await s.run({ workflow_id: "kling-i2v", inputs: { prompt: "p" }, wait_s: 10 });
  assert.equal(reply.generation_id, "501");
  assert.equal(reply.status, "in_progress");
  assert.equal(reply.tokens_cost, 12);
  assert.match(reply.hint, /after 10s/);
  assert.match(reply.hint, /WOKEN/);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/check")).length, 2);
  assert.equal(s.gens()[0].status, "running");
  assert.equal(s.rec.usage.length, 0);
});

test("timeout without ctx.jobs (older core): points at loremax_result", async () => {
  const f0 = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  delete f0.ctx.jobs;
  const clock = { t: 0 };
  await activate(f0.ctx, { pollMs: 1, now: () => clock.t });
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    ["POST", "/check", () => ((clock.t += 20_000), { status: "pending" })],
  ]);
  restore = f.restore;
  const r = JSON.parse((await f0.rec.tools.get("loremax_generate").handler({ workflow_id: "w", inputs: {}, wait_s: 10 }, CALL)).content[0].text);
  assert.equal(r.status, "in_progress");
  assert.match(r.hint, /call loremax_result/);
});

test("failed check (HTTP 500): job settles failed and the tool throws LoreMax's error", async () => {
  const s = await setup();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [{ status: "pending" }, jsonResponse({ status: "failed", error: "NSFW content detected", errorType: "moderation" }, 500)]),
  ]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: { prompt: "p" } }), /LoreMax generation 501 failed: NSFW content detected/);
  assert.equal(s.gens()[0].status, "failed");
  assert.equal(s.gens()[0].error, "NSFW content detected (moderation)");
  assert.equal(s.rec.usage.length, 0);
});

test("a check that errors otherwise keeps the job tracked and says so", async () => {
  const s = await setup();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    ["POST", "/check", () => new Response("gateway down", { status: 502 })],
  ]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), /generation 501 status check failed: loremax 502.*loremax_result/s);
  assert.equal(s.gens()[0].status, "running");
});

test("402 on execute: outOfFunds recorded, nothing tracked", async () => {
  const s = await setup();
  const f = mockFetch([["POST", "/api/v2/workflow/execute", () => jsonResponse({ error: "Insufficient tokens" }, 402)]]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: { prompt: "p" } }), /loremax 402/);
  assert.equal(s.rec.outOfFunds.length, 1);
  assert.equal(s.rec.outOfFunds[0].provider, "LoreMax");
  assert.equal(s.gens().length, 0);
  assert.equal(f.calls.length, 1);
});

test("a workflow that finishes right away: outputs from the execute reply, no /check, its row settled and found by loremax_result", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/now.png`] }, 202)],
    ["GET", `${CDN}/now.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "flux-portrait", inputs: { prompt: "p" } });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.artifacts, ["task-9/flux-portrait-777.png"]);
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.gens().length, 1);
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.usage[0].units, 5);
  assert.equal(s.rec.usage[0].ref, "777");
  // the agent may poll it afterwards: the saved files, no new download
  const later = JSON.parse((await s.rec.tools.get("loremax_result").handler({ generation_id: "777" }, CALL)).content[0].text);
  assert.equal(later.status, "completed");
  assert.deepEqual(later.artifacts, ["task-9/flux-portrait-777.png"]);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/now.png")).length, 1);
});

test("a synchronous run ('success', only externalUrls): saved from the reply, never polled", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 778, status: "success", tokensCost: 4, externalUrls: [`${CDN}/ext.png`] }, 202)],
    ["GET", `${CDN}/ext.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "flux-portrait", inputs: { prompt: "p" } });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.artifacts, ["task-9/flux-portrait-778.png"]);
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.gens()[0].status, "succeeded");
});

test("Text workflow: a sync reply carrying the text is saved as .md, no /check and no MCP call", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 780, status: "completed", tokensCost: 2, textContent: "A short tale." }, 202)],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "story", inputs: { prompt: "p" } });
  assert.deepEqual(r.artifacts, ["task-9/story-780.md"]);
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/story-780.md"), "utf8"), "A short tale.");
  assert.equal(f.calls.length, 1);
  assert.equal(s.rec.usage.length, 1);
});

test("Text workflow: a sync reply without URLs reads the text from one REST /check", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 781, status: "completed", tokensCost: 3 }, 202)],
    ["POST", "/api/v2/generations/781/check", () => ({ generationId: 781, status: "completed", completed: true, result: { previewUrls: [], originalUrls: [], externalUrls: [], contentTypes: [], textContent: "Once upon a time." } })],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "story", inputs: { prompt: "p" } });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.artifacts, ["task-9/story-781.md"]);
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/story-781.md"), "utf8"), "Once upon a time.");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/check")).length, 1);
  assert.equal(f.calls.some((c) => c.url.endsWith("/api/mcp")), false);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.usage[0].ref, "781");
});

test("Text workflow: a /check without result (an older LoreMax) falls back to one check_generation", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 782, status: "completed", tokensCost: 3 }, 202)],
    // the deployed LoreMax may still refuse /check for a synchronous row
    ["POST", "/api/v2/generations/782/check", () => jsonResponse({ error: "not an async generation" }, 400)],
    ["POST", "/api/mcp", (req) => mcpResult({ generationId: 782, status: "completed", content_type: "text", text_content: "Plain words." }, req.json.id)],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "story", inputs: { prompt: "p" } });
  assert.deepEqual(r.artifacts, ["task-9/story-782.md"]);
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/story-782.md"), "utf8"), "Plain words.");
  const mcp = f.calls.filter((c) => c.url.endsWith("/api/mcp"));
  assert.equal(mcp.length, 1);
  assert.deepEqual(mcp[0].json.params, { name: "check_generation", arguments: { generationId: "782" } });
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.usage[0].units, 3);
});

test("a sync reply with really nothing to save: one /check, one check_generation, the unchanged no-files hint", async () => {
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => jsonResponse({ generationId: 783, status: "completed", tokensCost: 1 }, 202)],
    ["POST", "/api/v2/generations/783/check", () => ({ generationId: 783, status: "completed", completed: true })],
    ["POST", "/api/mcp", (req) => mcpResult({ generationId: 783, status: "completed" }, req.json.id)],
  ]);
  restore = f.restore;
  const s = await setup();
  const r = await s.run({ workflow_id: "w", inputs: {} });
  assert.deepEqual(r.artifacts, []);
  assert.match(r.hint, /no files/);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/check")).length, 1);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/api/mcp")).length, 1);
  assert.equal(s.rec.usage.length, 1);
});

test("execute with no reply (timeout / reset): says the generation may have been charged", async () => {
  const f = mockFetch([["POST", "/api/v2/workflow/execute", () => { throw new TypeError("fetch failed"); }]]);
  restore = f.restore;
  const s = await setup();
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), /no reply \(fetch failed\).*may have accepted and charged/);
  assert.equal(s.gens().length, 0);
});

test("execute cut off by a gateway 5xx (non-JSON body): says the generation may have been charged", async () => {
  restore = mockFetch([["POST", "/api/v2/workflow/execute", () => new Response("<html>524 timeout</html>", { status: 524 })]]).restore;
  const s = await setup();
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), /no reply \(loremax 524 .*may have accepted and charged/);
});

test("execute failed by LoreMax itself (JSON 500): a plain error, no charged warning", async () => {
  restore = mockFetch([["POST", "/api/v2/workflow/execute", () => jsonResponse({ error: "workflow crashed", status: "failed" }, 500)]]).restore;
  const s = await setup();
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), (e) => /loremax 500 .*workflow crashed/.test(e.message) && !/charged/.test(e.message));
});

test("the job row keeps inputs, references, cost and note as track() params", async () => {
  const s = await setup();
  s.put("refs/a.png", "A");
  const f = mockFetch([["POST", "/api/v2/workflow/execute", () => EXECUTE], checkRoute(s, [{ status: "pending" }])]);
  restore = f.restore;
  await s.run({ workflow_id: "w", inputs: { prompt: "p" }, references: ["artifacts/refs/a.png"], wait_s: 10, note: "hero" });
  assert.deepEqual(s.gens()[0].params, { inputs: { prompt: "p" }, references: ["artifacts/refs/a.png"], tokensCost: 12, note: "hero" });
});

test("default_wait_s from config sets the wait; an emptied or bogus value falls back to 45; clamped to 10..50", async () => {
  for (const [value, waited] of [[30, 30], ["", 45], ["${LOREMAX_WAIT}", 45], [99_999, 50], [3, 10]]) {
    const s = await setup({ config: { default_wait_s: value } });
    restore = mockFetch([["POST", "/api/v2/workflow/execute", () => EXECUTE], checkRoute(s, [{ status: "pending" }])]).restore;
    const r = await s.run({ workflow_id: "w", inputs: {} });
    restore();
    assert.equal(r.status, "in_progress");
    assert.match(r.hint, new RegExp(`after ${waited}s`), `default_wait_s=${JSON.stringify(value)}`);
  }
});

test("loremax_result without ctx.jobs (older core): only the starting workspace's generations, unknown ids refused", async () => {
  const f0 = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  delete f0.ctx.jobs;
  const clock = { t: 0 };
  await activate(f0.ctx, { pollMs: 1, now: () => clock.t });
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    ["POST", "/check", () => ((clock.t += 20_000), { status: "pending" })],
  ]);
  restore = f.restore;
  await f0.rec.tools.get("loremax_generate").handler({ workflow_id: "w", inputs: {}, wait_s: 10 }, CALL);
  const result = f0.rec.tools.get("loremax_result");
  const checks = () => f.calls.filter((c) => c.url.endsWith("/check")).length;
  const before = checks();
  await assert.rejects(result.handler({ generation_id: "501" }, { ...CALL, workspace: "other" }), /not started from this workspace/);
  await assert.rejects(result.handler({ generation_id: "777" }, CALL), /not started from this workspace/);
  assert.equal(checks(), before);
  const own = JSON.parse((await result.handler({ generation_id: "501" }, CALL)).content[0].text);
  assert.equal(own.status, "in_progress");
});

/** A request held until the test opens it. */
const held = () => {
  let open;
  const until = new Promise((r) => (open = r));
  return { until, open };
};

test("wait_s is clamped in code: 10..50 for loremax_generate, 0..50 for loremax_result", async () => {
  for (const [value, waited] of [[5, 10], [999, 50], [20, 20]]) {
    const s = await setup();
    restore = mockFetch([["POST", "/api/v2/workflow/execute", () => EXECUTE], checkRoute(s, [{ status: "pending" }])]).restore;
    const r = await s.run({ workflow_id: "w", inputs: {}, wait_s: value });
    restore();
    assert.match(r.hint, new RegExp(`after ${waited}s`), `wait_s=${value}`);
  }
  const s = await setup();
  restore = mockFetch([["POST", "/api/v2/workflow/execute", () => EXECUTE], checkRoute(s, [{ status: "pending" }])]).restore;
  await s.run({ workflow_id: "w", inputs: {}, wait_s: 10 });
  const result = s.rec.tools.get("loremax_result");
  const started = s.clock.t;
  const r = JSON.parse((await result.handler({ generation_id: "501", wait_s: 999 }, CALL)).content[0].text);
  assert.match(r.hint, /after 50s/);
  // 50 s of checks (plus the 1 ms poll sleeps)
  assert.ok(s.clock.t - started >= 50_000 && s.clock.t - started < 51_000);
  assert.match(s.tool.description, /at most 50s/);
  assert.match(result.description, /up to 50s/);
});

test("a fast call settles its submission placeholder: no running submit: row is left", async () => {
  const s = await setup();
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG")],
  ]).restore;
  const r = await s.run({ workflow_id: "w", inputs: { prompt: "p" }, note: "hero" });
  assert.equal(r.status, "completed");
  assert.equal(s.placeholders().length, 1);
  const ph = s.placeholders()[0];
  assert.match(ph.externalId, /^submit:[0-9a-f-]{36}$/);
  assert.equal(ph.model, "w");
  assert.equal(ph.status, "succeeded");
  assert.deepEqual(ph.result, { workspace: "studio", generationId: "501" });
  assert.equal(s.ctx.jobs.pending().length, 0);
  // nothing woken: the reply carried the result
  assert.equal(s.rec.wakes.length, 0);
});

test("a submission that fails fast settles the placeholder failed and throws", async () => {
  const s = await setup();
  restore = mockFetch([["POST", "/api/v2/workflow/execute", () => jsonResponse({ error: "bad input" }, 400)]]).restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), /loremax 400/);
  assert.equal(s.placeholders()[0].status, "failed");
  assert.match(s.placeholders()[0].error, /bad input/);
  assert.equal(s.ctx.jobs.pending().length, 0);
});

test("slow synchronous execute: replies submitting, then saves, bills and wakes with the files — never /check", async () => {
  const s = await setup();
  const gate = held();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", async () => {
      await gate.until;
      return { generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/now.png`] };
    }],
    ["GET", `${CDN}/now.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const replying = s.run({ workflow_id: "flux-portrait", inputs: { prompt: "p" }, note: "hero" });
  await s.time.expire();
  const reply = await replying;
  assert.equal(reply.status, "submitting");
  assert.match(reply.hint, /do NOT call loremax_generate again/);
  assert.match(reply.hint, /WOKEN/);
  // restart-visible while LoreMax renders
  assert.equal(s.ctx.jobs.pending().length, 1);
  assert.equal(s.ctx.jobs.pending()[0].params.submitting, true);

  gate.open();
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  const w = s.rec.wakes[0];
  assert.match(w.key, /^loremax-submit:[0-9a-f-]{36}$/);
  assert.equal(w.key, `loremax-${s.placeholders()[0].externalId}`);
  assert.equal(w.sessionKey, "sess-1");
  assert.match(w.prompt, /generation 777 finished: artifacts\/task-9\/flux-portrait-777\.png/);
  assert.ok(fs.existsSync(path.join(s.art, "task-9/flux-portrait-777.png")));
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.usage[0].units, 5);
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.placeholders()[0].status, "succeeded");
  assert.deepEqual(s.placeholders()[0].result, { workspace: "studio", generationId: "777" });
  assert.equal(s.ctx.jobs.pending().length, 0);
});

test("slow async execute: replies submitting, then tracks the generation; the watcher finishes and wakes", async () => {
  const s = await setup();
  const gate = held();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", async () => {
      await gate.until;
      return EXECUTE;
    }],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const replying = s.run({ workflow_id: "kling", inputs: { prompt: "p" } });
  await s.time.expire();
  assert.equal((await replying).status, "submitting");
  gate.open();
  await eventually(() => s.gens().length === 1, "the generation row");
  await eventually(() => s.placeholders()[0].status === "succeeded", "the placeholder settle");
  assert.equal(s.gens()[0].externalId, "501");
  assert.deepEqual(s.gens()[0].params, { inputs: { prompt: "p" }, references: [], tokensCost: 12, note: "p" });
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.rec.wakes.length, 0);

  await s.watchOnce();
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.wakes.length, 1);
  assert.match(s.rec.wakes[0].prompt, /LoreMax generation 501 .*finished: artifacts\/task-9\/kling-501\.png/);
  assert.equal(s.rec.usage.length, 1);
});

test("a late definite failure wakes with LoreMax's error; an ambiguous one with the may-have-been-charged text", async () => {
  for (const [answer, expect, not] of [
    [() => jsonResponse({ error: "workflow crashed", status: "failed" }, 500), /FAILED: loremax 500 .*workflow crashed.*Decide whether to retry/, /charged/],
    [() => { throw new TypeError("fetch failed"); }, /no reply \(fetch failed\).*may have accepted and charged.*before running it again/, /Decide whether to retry/],
  ]) {
    const s = await setup();
    const gate = held();
    restore = mockFetch([["POST", "/api/v2/workflow/execute", async () => {
      await gate.until;
      return answer();
    }]]).restore;
    const replying = s.run({ workflow_id: "w", inputs: {}, note: "hero" });
    await s.time.expire();
    assert.equal((await replying).status, "submitting");
    gate.open();
    await eventually(() => s.rec.wakes.length === 1, "the wake");
    assert.match(s.rec.wakes[0].prompt, /^LoreMax w \(hero\)/);
    assert.match(s.rec.wakes[0].prompt, expect);
    assert.doesNotMatch(s.rec.wakes[0].prompt, not);
    assert.equal(s.placeholders()[0].status, "failed");
    assert.equal(s.gens().length, 0);
    assert.equal(s.rec.usage.length, 0);
    restore();
  }
});

test("a synchronous result too close to the deadline is saved in the background and woken", async () => {
  const s = await setup();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => {
      // the render took 42 s of the 50 s the call may last
      s.clock.t += 42_000;
      return { generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/now.png`] };
    }],
    ["GET", `${CDN}/now.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const reply = await s.run({ workflow_id: "flux-portrait", inputs: {}, wait_s: 50 });
  assert.equal(reply.status, "in_progress");
  assert.equal(reply.generation_id, "777");
  assert.match(reply.hint, /WOKEN with the files/);
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.match(s.rec.wakes[0].prompt, /artifacts\/task-9\/flux-portrait-777\.png/);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
});

test("completed near the deadline: in_progress without saving; the watcher saves it and wakes", async () => {
  const s = await setup({ tick: 41_000 });
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const reply = await s.run({ workflow_id: "w", inputs: {} });
  assert.equal(reply.status, "in_progress");
  assert.match(reply.hint, /LoreMax finished it/);
  assert.equal(s.gens()[0].status, "running");
  assert.equal(s.rec.usage.length, 0);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/out.png")).length, 0);

  await s.watchOnce();
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.usage.length, 1);
  assert.match(s.rec.wakes[0].prompt, /finished: artifacts\/task-9\/w-501\.png/);
});

test("a synchronous result whose downloads outlast the deadline: the reply comes at 50 s, the save goes on and wakes once", async () => {
  const s = await setup();
  const gate = held();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => ({ generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/big.mp4`] })],
    ["GET", `${CDN}/big.mp4`, async () => {
      await gate.until;
      return new Response("MP4", { headers: { "content-type": "video/mp4" } });
    }],
  ]);
  restore = f.restore;
  const replying = s.run({ workflow_id: "kling", inputs: {}, note: "hero" });
  // the download hangs on a slow CDN until the 50 s deadline passes
  await eventually(() => f.calls.some((c) => c.url.endsWith("/big.mp4")), "the download");
  await s.time.expire();
  const reply = await replying;
  assert.equal(reply.status, "in_progress");
  assert.equal(reply.generation_id, "777");
  assert.match(reply.hint, /being saved.*WOKEN with the files/);
  assert.ok(s.clock.t <= 50_000);
  assert.equal(s.rec.usage.length, 0);
  // the generation's own row took over: a restart now leaves it to the watcher, not a "may have been charged" wake
  assert.equal(s.placeholders()[0].status, "succeeded");
  assert.equal(s.gens()[0].status, "running");
  // meanwhile loremax_result does not start a second save
  const meanwhile = JSON.parse((await s.rec.tools.get("loremax_result").handler({ generation_id: "777" }, CALL)).content[0].text);
  assert.match(meanwhile.hint, /being checked and saved right now/);

  gate.open();
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.equal(s.rec.wakes[0].key, `loremax-${s.placeholders()[0].externalId}`);
  assert.match(s.rec.wakes[0].prompt, /generation 777 finished: artifacts\/task-9\/kling-777\.mp4/);
  assert.ok(fs.existsSync(path.join(s.art, "task-9/kling-777.mp4")));
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/big.mp4")).length, 1);
  assert.equal(f.calls.some((c) => c.url.includes("/check")), false);
});

test("a polled generation whose downloads outlast the deadline: saved in the background, one wake, the watcher never saves it twice", async () => {
  const s = await setup();
  const gate = held();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, async () => {
      await gate.until;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
  ]);
  restore = f.restore;
  const downloads = () => f.calls.filter((c) => c.url.endsWith("/out.png")).length;
  const replying = s.run({ workflow_id: "w", inputs: { prompt: "p" } });
  await eventually(() => downloads() === 1, "the download");
  await s.time.expire();
  const reply = await replying;
  assert.equal(reply.status, "in_progress");
  assert.equal(reply.generation_id, "501");
  assert.match(reply.hint, /being saved.*WOKEN with the files/);
  assert.ok(s.clock.t <= 50_000);
  assert.equal(s.gens()[0].status, "running");
  // a watcher pass while the save runs leaves the generation to it
  await s.watchOnce();
  assert.equal(downloads(), 1);
  assert.equal(s.rec.wakes.length, 0);

  gate.open();
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  const w = s.rec.wakes[0];
  assert.equal(w.key, `loremax-job:${s.gens()[0].id}`);
  assert.equal(w.sessionKey, "sess-1");
  assert.match(w.prompt, /LoreMax generation 501 \(w — p · 12 tk\) finished: artifacts\/task-9\/w-501\.png .*\(task task-9\)/);
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.usage.length, 1);
  await s.watchOnce();
  assert.equal(s.rec.wakes.length, 1);
  assert.equal(downloads(), 1);
  assert.equal(s.rec.usage.length, 1);
});

test("older core without wakeAgent: a slow download blocks the call as in 0.1.0 and is saved inline", async () => {
  const s = await setup({ patch: (ctx) => delete ctx.wakeAgent });
  const gate = held();
  let answered = false;
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => ({ generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/now.png`] })],
    ["GET", `${CDN}/now.png`, async () => {
      await gate.until;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
  ]).restore;
  const replying = s.run({ workflow_id: "w", inputs: {} }).then((r) => ((answered = true), r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(answered, false);
  assert.equal(s.time.races.length, 0);
  gate.open();
  const reply = await replying;
  assert.equal(reply.status, "completed");
  assert.deepEqual(reply.artifacts, ["task-9/w-777.png"]);
});

test("a Retry-After that does not fit before the deadline is not slept; one that fits is", async () => {
  const s = await setup({ tick: 25_000 });
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" })]),
  ]).restore;
  const r = await s.run({ workflow_id: "w", inputs: {} });
  assert.equal(r.status, "in_progress");
  assert.equal(s.time.slept.includes(30_000), false);
  assert.equal(s.gens()[0].status, "running");
  restore();

  const s2 = await setup({ tick: 1_000 });
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s2, [jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" }), DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG")],
  ]).restore;
  const r2 = await s2.run({ workflow_id: "w", inputs: {} });
  assert.equal(r2.status, "completed");
  assert.ok(s2.time.slept.includes(2_000));
});

test("older core without wakeAgent: the submission blocks as in 0.1.0, no placeholder row", async () => {
  const s = await setup({ patch: (ctx) => delete ctx.wakeAgent });
  const gate = held();
  let answered = false;
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", async () => {
      await gate.until;
      return EXECUTE;
    }],
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, () => new Response("PNG")],
  ]).restore;
  const replying = s.run({ workflow_id: "w", inputs: {} }).then((r) => ((answered = true), r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(answered, false);
  assert.equal(s.time.races.length, 0);
  gate.open();
  const r = await replying;
  assert.equal(r.status, "completed");
  assert.equal(s.placeholders().length, 0);
  assert.equal(s.jobs.length, 1);
});

// ---------- profile mode ----------

const PROFILE = "AbCdEfGh12345678";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));
const REV = Object.fromEntries(FIXTURE.result.tools.filter((t) => t.inputSchema?.properties?.schema_revision?.enum).map((t) => [t.name, t.inputSchema.properties.schema_revision.enum[0]]));
const UPLOAD_TOOLS = new Set(["request_upload_url", "finalize_upload"]);

/** A profile tool refusal the way LoreMax shapes it: `isError` with `{error, errorCode?, details?}`. */
const refusal = (error, errorCode, details) => ({ isError: { error, ...(errorCode ? { errorCode } : {}), ...(details ? { details } : {}) } });

/**
 * Profile mode on the fake clock. The profile answers tools/list with `tools()`, the upload
 * tools with tickets (PUT to r2.test) and `https://cdn.test/<asset>`, and a generation tool
 * with `gen(name, args)`: plain data, `refusal(…)`, or `{ rpcError }` (a JSON-RPC error); a
 * throw drops the connection. `onPost(req)` may answer a whole POST, `onPut(req)` a PUT.
 */
const profileSetup = async ({ gen = () => ({}), tools = () => structuredClone(FIXTURE.result.tools), onPost, onPut, routes = [], patch, tick = 1_000 } = {}) => {
  // the upload cache is process-wide: every test starts cold
  globalThis[Symbol.for("bridex.loremax.uploads")]?.clear();
  const s = await setup({ config: { profile_url: PROFILE }, tick, patch });
  let tickets = 0;
  const reply = async (m) => {
    const head = { jsonrpc: "2.0", id: m.id };
    if (m.method === "tools/list") return { ...head, result: { tools: tools() } };
    const { name, arguments: a } = m.params;
    let data;
    if (name === "request_upload_url") {
      const n = ++tickets;
      data = { asset_id: `a${n}`, upload_url: `https://r2.test/put/a${n}`, headers: { "Content-Type": a.mime }, expires_at: "2026-10-12T00:15:00Z" };
    } else if (name === "finalize_upload") {
      data = { id: a.asset_id, url: `https://cdn.test/${a.asset_id}` };
    } else {
      const out = await gen(name, a);
      if (out?.rpcError) return { ...head, error: out.rpcError };
      if (out?.isError) return { ...head, result: { content: [{ type: "text", text: JSON.stringify(out.isError) }], isError: true } };
      data = out;
    }
    return { ...head, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
  };
  const f = mockFetch([
    ["POST", `/api/mcp/s/${PROFILE}`, async (req) => {
      const own = await onPost?.(req);
      if (own) return own;
      return jsonResponse(Array.isArray(req.json) ? await Promise.all(req.json.map(reply)) : await reply(req.json));
    }],
    ["PUT", "https://r2.test/put/", async (req) => (await onPut?.(req)) ?? new Response(null, { status: 200 })],
    ...routes,
  ]);
  restore = f.restore;
  const work = s.ctx.paths.workspaceWorkdir(CALL.workspace);
  /** A file in the workdir. */
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
    return rel;
  };
  const msgs = () => f.calls.filter((c) => c.method === "POST" && c.url.includes("/api/mcp/s/")).flatMap((c) => (Array.isArray(c.json) ? c.json : [c.json]));
  /** The generation tools/call messages sent (uploads and tools/list aside). */
  const genCalls = () => msgs().filter((m) => m.method === "tools/call" && !UPLOAD_TOOLS.has(m.params.name)).map((m) => m.params);
  const lists = () => msgs().filter((m) => m.method === "tools/list").length;
  return { ...s, f, write, msgs, genCalls, lists };
};

test("profile: loremax_generate is registered with {tool, arguments, wait_s, note} and a paid, workspace-path description", async () => {
  const s = await profileSetup();
  assert.deepEqual(Object.keys(s.tool.schema), ["tool", "arguments", "wait_s", "note"]);
  assert.match(s.tool.description, /PAID/);
  assert.match(s.tool.description, /loremax_workflows first/);
  assert.match(s.tool.description, /workspace paths/);
  assert.match(s.tool.description, /Never call it again for a submitting reply/);
  assert.doesNotMatch(s.tool.description, /workflow_id/);
});

test("profile happy path: uploads, injected revision and on_behalf_of, sync outputs saved with provenance and usage", async () => {
  const s = await profileSetup({
    gen: () => ({ generationId: 901, status: "completed", tokensCost: 7, async: false, originalUrls: [`${CDN}/edit.png`], content_type: "image" }),
    routes: [["GET", `${CDN}/edit.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })]],
  });
  s.write("src.png", "source bytes");
  s.put("t0/mask.png", "mask bytes");
  const reply = await s.run({
    tool: "masked_edit",
    // the injected arguments are the plugin's: what the agent sends for them is dropped
    arguments: { text: "fix the sky", source: "src.png", edit_mask: "artifacts/t0/mask.png", api_key: "lmx_prod_other", schema_revision: "stale", on_behalf_of: "me" },
    note: "sky fix",
  });

  assert.equal(s.genCalls().length, 1);
  const g = s.genCalls()[0];
  assert.equal(g.name, "masked_edit");
  assert.deepEqual(g.arguments, {
    text: "fix the sky",
    source: "https://cdn.test/a1",
    edit_mask: "https://cdn.test/a2",
    schema_revision: REV.masked_edit,
    on_behalf_of: "bridex:studio:illustrator",
  });
  // one Bearer key everywhere, and only the profile path: no REST execute in profile mode
  assert.ok(s.f.calls.filter((c) => c.method === "POST").every((c) => c.url === `${BASE}/api/mcp/s/${PROFILE}` && c.headers.authorization === "Bearer lmx_prod_k"));
  assert.ok(s.msgs().filter((m) => UPLOAD_TOOLS.has(m.params?.name)).every((m) => !("on_behalf_of" in m.params.arguments)));

  assert.deepEqual(reply, {
    generation_id: "901",
    status: "completed",
    workflow: "masked-edit",
    artifacts: ["task-9/masked-edit-901.png"],
    tokens_cost: 7,
    hint: "reference outputs as [media: artifacts/<path>]",
  });
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/masked-edit-901.png"), "utf8"), "PNG");
  const gen = s.rec.annotate[0].meta.generation;
  assert.equal(gen.provider, "LoreMax");
  assert.equal(gen.workflow, "masked-edit");
  assert.equal(gen.externalId, "901");
  // the agent's arguments with workspace paths (never the uploaded URLs), the referenced paths, tool and profile
  assert.deepEqual(gen.params, {
    text: "fix the sky",
    source: "src.png",
    edit_mask: "artifacts/t0/mask.png",
    tool: "masked_edit",
    profile: PROFILE,
    image_urls: ["src.png", "artifacts/t0/mask.png"],
  });
  assert.equal(s.rec.annotate[0].meta.description, "LoreMax masked-edit · generation 901 · sky fix");
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.usage[0].model, "masked-edit");
  assert.equal(s.rec.usage[0].ref, "901");
  assert.equal(s.rec.usage[0].units, 7);
  // finished from the reply: no REST check; its generation row is settled, and so is the placeholder
  assert.equal(s.f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.gens().length, 1);
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.gens()[0].params.mode, "profile");
  assert.equal(s.placeholders()[0].status, "succeeded");
  assert.deepEqual(s.placeholders()[0].params, { submitting: true, mode: "profile", tool: "masked_edit", note: "sky fix" });
  assert.equal(s.ctx.jobs.pending().length, 0);
});

test("profile: on_behalf_of is reduced to LoreMax's characters, trimmed and capped at 128", async () => {
  const s = await profileSetup({ gen: () => ({ generationId: 5, status: "completed", tokensCost: 1, textContent: "ok" }) });
  await s.run({ tool: "write_text", arguments: { text: "hi" } }, { ...CALL, workspace: "stüdio/ü", agent: `${"a<b>".repeat(60)}  ` });
  const obo = s.genCalls()[0].arguments.on_behalf_of;
  assert.match(obo, /^[A-Za-z0-9._:@ -]+$/);
  assert.ok(obo.startsWith("bridex:stdio:abab"));
  assert.ok(obo.length <= 128);
  assert.equal(obo, obo.trim());
});

test("profile: a completed Text reply is saved as .md from the reply, no REST check", async () => {
  const s = await profileSetup({ gen: () => ({ generationId: 77, status: "completed", tokensCost: 2, async: false, text_content: "Once upon a time." }) });
  const r = await s.run({ tool: "write_text", arguments: { text: "a fairy tale" } });
  assert.deepEqual(r.artifacts, ["task-9/write-text-77.md"]);
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/write-text-77.md"), "utf8"), "Once upon a time.");
  assert.equal(s.f.calls.some((c) => c.url.includes("/check")), false);
  assert.equal(s.rec.usage[0].model, "write_text");
});

test("profile: a pending reply, or a completed pipeline reply without URLs, is tracked with profile params and polled via the REST check", async () => {
  for (const sub of [
    { generationId: 501, status: "pending", tokensCost: 12, async: true, jobId: "j" },
    { generationId: 501, status: "completed", tokensCost: 12, async: true },
  ]) {
    let checks = 0;
    const s = await profileSetup({
      gen: () => sub,
      routes: [
        ["POST", "/api/v2/generations/501/check", () => (++checks === 1 ? { status: "checking" } : DONE)],
        ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
      ],
    });
    s.write("a.png", "A");
    const r = await s.run({ tool: "styled_portrait", arguments: { style: "noir", references: ["a.png"] }, note: "hero" });
    assert.equal(r.status, "completed");
    assert.equal(checks, 2);
    assert.deepEqual(r.artifacts, ["task-9/styled-portrait-501.png"]);
    const row = s.gens()[0];
    assert.equal(row.externalId, "501");
    assert.equal(row.model, "styled-portrait");
    assert.equal(row.label, "hero · 12 tk");
    // restart-safe: the workspace paths, never the uploaded URLs
    assert.deepEqual(row.params, {
      mode: "profile",
      tool: "styled_portrait",
      arguments: { style: "noir", references: ["a.png"] },
      references: ["a.png"],
      tokensCost: 12,
      note: "hero",
      identity: { workflowId: 12, visualId: "styled-portrait", title: "Styled portrait", category: "Portraits", contentType: "image", pipeline: true },
      profile: PROFILE,
    });
    assert.equal(row.status, "succeeded");
    assert.equal(s.rec.usage.length, 1);
    assert.equal(s.rec.usage[0].ref, "501");
    restore();
  }
});

/** After a call that produced no generation: nothing billed, nothing tracked, the placeholder settled failed. */
const nothingCharged = (s) => {
  assert.equal(s.rec.usage.length, 0);
  assert.equal(s.gens().length, 0);
  assert.equal(s.ctx.jobs.pending().length, 0);
  assert.ok(s.placeholders().every((p) => p.status === "failed"));
};

test("profile preflight refusals: not charged, issues and the tool's schema in the reply", async () => {
  for (const code of ["INVALID_WORKFLOW_INPUT", "MEDIA_INPUT_INVALID"]) {
    const issues = [{ path: ["text"], message: "Required" }];
    const s = await profileSetup({ gen: () => refusal("Invalid workflow input", code, { issues }) });
    const r = await s.run({ tool: "write_text", arguments: {} });
    assert.equal(r.status, "rejected");
    assert.equal(r.charged, false);
    assert.equal(r.error_code, code);
    assert.deepEqual(r.issues, issues);
    assert.deepEqual(Object.keys(r.schema.properties), ["text"]);
    assert.match(r.hint, /not charged/);
    // the catalog was fine: no extra tools/list
    assert.equal(s.lists(), 1);
    nothingCharged(s);
    restore();
  }
});

test("profile SCHEMA_REVISION_MISMATCH: the catalog is reread and the fresh schema returned, never retried", async () => {
  let version = 0;
  const tools = () => {
    const list = structuredClone(FIXTURE.result.tools);
    if (version > 0) {
      const t = list.find((x) => x.name === "write_text");
      t.inputSchema.properties.schema_revision.enum = ["rev-new"];
      t.inputSchema.properties.tone = { type: "string", enum: ["dry", "warm"] };
      t.inputSchema.required.push("tone");
    }
    return list;
  };
  const s = await profileSetup({
    tools,
    gen: (name, a) => {
      if (a.schema_revision === "rev-new") return { generationId: 9, status: "completed", tokensCost: 1, textContent: "ok" };
      version = 1;
      return refusal("schema_revision does not match", "SCHEMA_REVISION_MISMATCH");
    },
  });
  const r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
  assert.equal(r.status, "rejected");
  assert.equal(r.charged, false);
  assert.equal(r.error_code, "SCHEMA_REVISION_MISMATCH");
  assert.ok(r.schema.properties.tone);
  assert.ok(r.schema.required.includes("tone"));
  assert.match(r.hint, /schema changed/);
  assert.equal(s.lists(), 2);
  assert.equal(s.genCalls().length, 1);
  nothingCharged(s);
  // the agent's next call goes out with the new revision from the refreshed cache
  const again = await s.run({ tool: "write_text", arguments: { text: "hi", tone: "dry" } });
  assert.equal(again.status, "completed");
  assert.equal(s.genCalls()[1].arguments.schema_revision, "rev-new");
  assert.equal(s.lists(), 2);
});

test("profile WORKFLOW_UNAVAILABLE, -32601 and an unknown name: refreshed, 'unavailable' with the current tool list", async () => {
  for (const [gen, code] of [
    [() => refusal("workflow is not published", "WORKFLOW_UNAVAILABLE"), "WORKFLOW_UNAVAILABLE"],
    [() => ({ rpcError: { code: -32601, message: "Tool not found" } }), "TOOL_NOT_FOUND"],
  ]) {
    const s = await profileSetup({ gen });
    const r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
    assert.equal(r.status, "rejected");
    assert.equal(r.charged, false);
    assert.equal(r.error_code, code);
    assert.deepEqual(r.tools, ["write_text", "masked_edit", "styled_portrait"]);
    assert.match(r.hint, /unavailable/);
    assert.equal(s.lists(), 2);
    nothingCharged(s);
    restore();
  }
  // a name the profile never had: one refresh, then the same reply, and no paid call at all
  const s = await profileSetup();
  const r = await s.run({ tool: "nope", arguments: {} });
  assert.equal(r.status, "rejected");
  assert.equal(r.error_code, "TOOL_NOT_FOUND");
  assert.deepEqual(r.tools, ["write_text", "masked_edit", "styled_portrait"]);
  assert.equal(s.lists(), 2);
  assert.equal(s.genCalls().length, 0);
  nothingCharged(s);
});

test("profile 404 and PROFILE_ORGANIZATION_MISMATCH: a config error with the three causes", async () => {
  const s = await profileSetup({ onPost: () => new Response("not found", { status: 404 }) });
  await assert.rejects(s.run({ tool: "write_text", arguments: { text: "hi" } }), (e) => e.config === true && e.code === "PROFILE_NOT_FOUND" && /unknown, disabled in LoreMax, or LOREMAX_API_KEY belongs to another organization/.test(e.message));
  nothingCharged(s);
  restore();

  const s2 = await profileSetup({ gen: () => refusal("profile belongs to another organization", "PROFILE_ORGANIZATION_MISMATCH") });
  await assert.rejects(s2.run({ tool: "write_text", arguments: { text: "hi" } }), (e) => e.config === true && /another organization/.test(e.message) && /profile_url/.test(e.message));
  nothingCharged(s2);
});

test("profile INSUFFICIENT_TOKENS: the out-of-funds card and a failed, not-charged reply", async () => {
  const s = await profileSetup({ gen: () => refusal("Insufficient tokens", "INSUFFICIENT_TOKENS", { requiredTokens: 40 }) });
  const r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
  assert.equal(r.status, "failed");
  assert.equal(r.charged, false);
  assert.equal(r.error_code, "INSUFFICIENT_TOKENS");
  assert.equal(r.required_tokens, 40);
  assert.match(r.hint, /top it up/);
  assert.equal(s.rec.outOfFunds.length, 1);
  nothingCharged(s);
});

test("profile GENERATION_FAILED, an uncoded isError and a 'failed' success reply: failed with the generation id, never tracked", async () => {
  for (const [gen, code, gid] of [
    [() => refusal("render crashed", "GENERATION_FAILED", { generationId: 640 }), "GENERATION_FAILED", "640"],
    [() => refusal("something broke"), undefined, undefined],
    [() => ({ generationId: 641, status: "failed", error: "nsfw filter", tokensCost: 0 }), "GENERATION_FAILED", "641"],
  ]) {
    const s = await profileSetup({ gen });
    const r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, code);
    assert.equal(r.generation_id, gid);
    assert.match(r.hint, /refunds failed runs/);
    assert.match(r.hint, /do not retry blindly/);
    nothingCharged(s);
    restore();
  }
});

test("profile: no reply to the paid call says it may have been charged", async () => {
  const s = await profileSetup({ gen: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(s.run({ tool: "write_text", arguments: { text: "hi" } }), /got no reply \(fetch failed\).*may have accepted and charged/);
  assert.equal(s.rec.usage.length, 0);
  assert.equal(s.placeholders()[0].status, "failed");
});

test("profile: a refused upload aborts before the paid call with 'nothing was charged'", async () => {
  const s = await profileSetup({ onPut: () => new Response("denied", { status: 403 }) });
  s.write("src.png", "S");
  await assert.rejects(s.run({ tool: "masked_edit", arguments: { text: "t", source: "src.png" } }), /upload of src\.png failed \(HTTP 403\).*nothing was charged/);
  assert.equal(s.genCalls().length, 0);
  nothingCharged(s);
});

test("profile: slow uploads reply submitting; the paid call runs after, and the agent is woken with the files", async () => {
  const gate = held();
  const s = await profileSetup({
    onPut: async () => {
      await gate.until;
    },
    gen: () => ({ generationId: 902, status: "completed", tokensCost: 3, originalUrls: [`${CDN}/late.png`] }),
    routes: [["GET", `${CDN}/late.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })]],
  });
  s.write("src.png", "S");
  const replying = s.run({ tool: "masked_edit", arguments: { text: "t", source: "src.png" }, note: "late" });
  await s.time.expire();
  const r = await replying;
  assert.equal(r.status, "submitting");
  assert.equal(r.tool, "masked_edit");
  assert.match(r.hint, /do NOT call loremax_generate again/);
  // still uploading: nothing paid yet
  assert.equal(s.genCalls().length, 0);
  assert.equal(s.ctx.jobs.pending().length, 1);

  gate.open();
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.equal(s.genCalls().length, 1);
  assert.match(s.rec.wakes[0].prompt, /^LoreMax masked_edit \(late\) — generation 902 finished: artifacts\/task-9\/masked-edit-902\.png/);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.placeholders()[0].status, "succeeded");
  assert.equal(s.ctx.jobs.pending().length, 0);
});

test("profile: a refusal after submitting wakes with the not-charged reason", async () => {
  const gate = held();
  const s = await profileSetup({
    onPut: async () => {
      await gate.until;
    },
    gen: () => refusal("source is too small", "MEDIA_INPUT_INVALID", { issues: [{ path: ["source"], message: "min 64px" }] }),
  });
  s.write("src.png", "S");
  const replying = s.run({ tool: "masked_edit", arguments: { text: "t", source: "src.png" } });
  await s.time.expire();
  assert.equal((await replying).status, "submitting");
  gate.open();
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.match(s.rec.wakes[0].prompt, /was refused before it ran \(not charged\): .*source is too small — issues: .*min 64px/);
  nothingCharged(s);
});

test("profile: late outcomes after submitting — a lost reply, a failed run, an accepted async one", async () => {
  const late = async (gen, routes = []) => {
    const gate = held();
    const s = await profileSetup({
      onPut: async () => {
        await gate.until;
      },
      gen,
      routes,
    });
    s.write("src.png", "S");
    const replying = s.run({ tool: "masked_edit", arguments: { text: "t", source: "src.png" }, note: "late" });
    await s.time.expire();
    assert.equal((await replying).status, "submitting");
    gate.open();
    return s;
  };

  // no reply to the paid call: the wake says it may have been charged
  let s = await late(() => {
    throw new TypeError("fetch failed");
  });
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.match(s.rec.wakes[0].prompt, /got no reply \(fetch failed\).*may have accepted and charged/);
  assert.equal(s.placeholders()[0].status, "failed");
  assert.equal(s.gens().length, 0);
  restore();

  // a run that failed on LoreMax: FAILED with its generation id
  s = await late(() => refusal("render crashed", "GENERATION_FAILED", { generationId: 650 }));
  await eventually(() => s.rec.wakes.length === 1, "the wake");
  assert.match(s.rec.wakes[0].prompt, /FAILED: .*render crashed \(generation 650\)/);
  nothingCharged(s);
  restore();

  // accepted async: its own row takes over, and the watcher finishes it and wakes
  s = await late(() => ({ generationId: 501, status: "pending", tokensCost: 12, async: true }), [
    ["POST", "/api/v2/generations/501/check", () => DONE],
    ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]);
  await eventually(() => s.gens().length === 1, "the generation row");
  assert.equal(s.placeholders()[0].status, "succeeded");
  assert.equal(s.gens()[0].params.mode, "profile");
  assert.equal(s.rec.wakes.length, 0);
  await s.watchOnce();
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.wakes.length, 1);
  assert.match(s.rec.wakes[0].prompt, /finished: artifacts\/task-9\/masked-edit-501\.png/);
});

test("profile: a JSON-RPC error on the paid call says it may have been charged", async () => {
  const s = await profileSetup({ gen: () => ({ rpcError: { code: -32603, message: "Internal error" } }) });
  await assert.rejects(s.run({ tool: "write_text", arguments: { text: "hi" } }), (e) => e.ambiguous === true && /Internal error.*may have accepted and charged/.test(e.message));
  assert.equal(s.rec.usage.length, 0);
});

test("profile SCHEMA_REVISION_MISMATCH: a failed reread asks to reread the schema; a tool gone from it is 'unavailable'", async () => {
  // the reread fails: the tool may still be there, so no "pick another tool" with an empty list
  let listed = 0;
  let s = await profileSetup({
    onPost: (req) => (req.json?.method === "tools/list" && listed++ > 0 ? new Response("boom", { status: 500 }) : null),
    gen: () => refusal("schema_revision does not match", "SCHEMA_REVISION_MISMATCH"),
  });
  let r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
  assert.equal(r.status, "rejected");
  assert.equal(r.charged, false);
  assert.equal(r.error_code, "SCHEMA_REVISION_MISMATCH");
  assert.equal(r.tools, undefined);
  assert.match(r.hint, /read it again with loremax_workflows/);
  nothingCharged(s);
  restore();

  // the tool left the profile meanwhile
  let gone = false;
  s = await profileSetup({
    tools: () => structuredClone(FIXTURE.result.tools).filter((t) => !(gone && t.name === "write_text")),
    gen: () => ((gone = true), refusal("schema_revision does not match", "SCHEMA_REVISION_MISMATCH")),
  });
  r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
  assert.equal(r.status, "rejected");
  assert.deepEqual(r.tools, ["masked_edit", "styled_portrait"]);
  assert.match(r.hint, /unavailable/);
  nothingCharged(s);
});

test("profile: a single-output reply naming only result_url is saved, its extension from contentTypes", async () => {
  const s = await profileSetup({
    gen: () => ({ generationId: 903, status: "completed", tokensCost: 1, result_url: `${CDN}/single`, contentTypes: ["video/mp4"] }),
    routes: [["GET", `${CDN}/single`, () => new Response("MP4")]],
  });
  const r = await s.run({ tool: "write_text", arguments: { text: "hi" } });
  assert.equal(r.status, "completed");
  assert.equal(r.artifacts.length, 1);
  assert.match(r.artifacts[0], /\.mp4$/);
});

test("profile: bad tool or arguments are refused before anything is sent; note defaults to the prompt", async () => {
  const s = await profileSetup({ gen: () => ({ generationId: 904, status: "completed", tokensCost: 1, textContent: "ok" }) });
  await assert.rejects(s.run({ tool: "  ", arguments: {} }), /tool is required/);
  await assert.rejects(s.run({ tool: "write_text", arguments: ["hi"] }), /arguments must be an object/);
  assert.equal(s.f.calls.length, 0);
  assert.equal(s.jobs.length, 0);
  await s.run({ tool: "write_text", arguments: { text: "hi", prompt: "a fairy tale" } });
  assert.equal(s.placeholders()[0].label, "a fairy tale");
});

test("a synchronous result whose save fails: the error comes back, the row stays for the watcher, which saves and wakes", async () => {
  let failures = 1;
  const s = await setup({
    patch: (ctx) => {
      const record = ctx.usage.record;
      ctx.usage.record = (u) => {
        if (failures-- > 0) throw new Error("usage store locked");
        return record(u);
      };
    },
  });
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => ({ generationId: 777, status: "completed", tokensCost: 5, originalUrls: [`${CDN}/now.png`] })],
    ["POST", "/api/v2/generations/777/check", () => ({ status: "completed", result: { originalUrls: [`${CDN}/now.png`] } })],
    ["GET", `${CDN}/now.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })],
  ]).restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: {} }), /usage store locked/);
  assert.equal(s.gens()[0].status, "running");
  assert.equal(s.placeholders()[0].status, "succeeded");
  await s.watchOnce();
  assert.equal(s.gens()[0].status, "succeeded");
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.wakes.length, 1);
  assert.match(s.rec.wakes[0].prompt, /generation 777 .*finished: artifacts\/task-9\/w-777\.png/);
});

test("a core with jobs but no wakeAgent: an unfinished wait points at loremax_result, never at a wake", async () => {
  const s = await setup({ patch: (ctx) => delete ctx.wakeAgent });
  restore = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    checkRoute(s, [{ status: "pending" }]),
  ]).restore;
  const r = await s.run({ workflow_id: "w", inputs: {}, wait_s: 10 });
  assert.equal(r.status, "in_progress");
  assert.match(r.hint, /call loremax_result/);
  assert.doesNotMatch(r.hint, /WOKEN/);
});

test("older core: uploads that leave under 15 s abort before the paid call; a retry reuses the cached upload", async () => {
  let slow = true;
  const s = await profileSetup({
    patch: (ctx) => delete ctx.wakeAgent,
    onPut: () => {
      // the upload ate 40 s of the 50 s the call may last
      if (slow) s.clock.t += 40_000;
    },
    gen: () => ({ generationId: 903, status: "completed", tokensCost: 3, originalUrls: [`${CDN}/ok.png`] }),
    routes: [["GET", `${CDN}/ok.png`, () => new Response("PNG")]],
  });
  s.write("src.png", "S");
  const args = { tool: "masked_edit", arguments: { text: "t", source: "src.png" } };
  await assert.rejects(s.run(args), (e) => e.charged === false && /nothing was charged; uploads are cached — call loremax_generate again/.test(e.message));
  assert.equal(s.genCalls().length, 0);
  assert.equal(s.time.races.length, 0);
  assert.equal(s.placeholders().length, 0);

  slow = false;
  const puts = s.f.calls.filter((c) => c.method === "PUT").length;
  const r = await s.run(args);
  assert.equal(r.status, "completed");
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, puts);
  assert.equal(s.genCalls()[0].arguments.source, "https://cdn.test/a1");
});
