import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse } from "./helpers.mjs";

const BASE = "https://lm.test";
const CDN = "https://cdn.lm.test";
const CALL = { workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: "run-1" };

/** activate with a fake clock: each /check advances it by `tick` ms, so wait_s runs out without real waiting. */
const setup = async ({ config = {}, tick = 1_000 } = {}) => {
  const f = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, ...config } });
  const clock = { t: 0, tick };
  await activate(f.ctx, { pollMs: 1, now: () => clock.t });
  const t = f.rec.tools.get("loremax_generate");
  const run = async (args, call = CALL) => JSON.parse((await t.handler(args, call)).content[0].text);
  const art = f.ctx.paths.workspaceArtifacts(CALL.workspace);
  const put = (rel, bytes) => {
    const abs = path.join(art, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  };
  return { ...f, clock, run, tool: t, art, put };
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

  assert.equal(s.jobs.length, 1);
  const j = s.jobs[0];
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
  assert.equal(s.jobs[0].label, "the knight at the castle · 12 tk");
});

test("a reference outside the workspace throws before any HTTP call", async () => {
  const s = await setup();
  fs.writeFileSync(path.join(s.dir, "outside.png"), "x");
  const f = mockFetch([]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "12", inputs: {}, references: ["../../outside.png"] }), /outside your workspace/);
  await assert.rejects(s.run({ workflow_id: "12", inputs: {}, references: ["artifacts/missing.png"] }), /file not found/);
  assert.equal(f.calls.length, 0);
  assert.equal(s.jobs.length, 0);
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
  assert.equal(s.jobs[0].status, "running");
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
  assert.equal(s.jobs[0].status, "failed");
  assert.equal(s.jobs[0].error, "NSFW content detected (moderation)");
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
  assert.equal(s.jobs[0].status, "running");
});

test("402 on execute: outOfFunds recorded, nothing tracked", async () => {
  const s = await setup();
  const f = mockFetch([["POST", "/api/v2/workflow/execute", () => jsonResponse({ error: "Insufficient tokens" }, 402)]]);
  restore = f.restore;
  await assert.rejects(s.run({ workflow_id: "w", inputs: { prompt: "p" } }), /loremax 402/);
  assert.equal(s.rec.outOfFunds.length, 1);
  assert.equal(s.rec.outOfFunds[0].provider, "LoreMax");
  assert.equal(s.jobs.length, 0);
  assert.equal(f.calls.length, 1);
});

test("a workflow that finishes right away: outputs from the execute reply, no /check, no job", async () => {
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
  assert.equal(s.jobs.length, 0);
  assert.equal(s.rec.usage[0].units, 5);
});

test("default_wait_s from config sets the wait; an emptied or bogus value falls back to 180", async () => {
  for (const [value, waited] of [[30, 30], ["", 180], ["${LOREMAX_WAIT}", 180], [99_999, 1500]]) {
    const s = await setup({ config: { default_wait_s: value } });
    restore = mockFetch([["POST", "/api/v2/workflow/execute", () => EXECUTE], checkRoute(s, [{ status: "pending" }])]).restore;
    const r = await s.run({ workflow_id: "w", inputs: {} });
    restore();
    assert.equal(r.status, "in_progress");
    assert.match(r.hint, new RegExp(`after ${waited}s`), `default_wait_s=${JSON.stringify(value)}`);
  }
});
