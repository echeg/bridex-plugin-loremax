import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, fakeSleep, eventually, generationRows } from "./helpers.mjs";

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
  assert.equal(s.gens().length, 0);
  assert.equal(s.rec.usage[0].units, 5);
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
  assert.equal(s.gens().length, 0);
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
