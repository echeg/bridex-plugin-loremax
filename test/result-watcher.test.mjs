import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult, mcpError } from "./helpers.mjs";

const BASE = "https://lm.test";
const CDN = "https://cdn.lm.test";
const CALL = { workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: "run-1" };
const DONE = { status: "completed", result: { originalUrls: [`${CDN}/out.png`], previewUrls: [], contentTypes: ["image/png"] } };
const PNG = ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })];

/** activate with a fake clock (advanced by hand or by each /check) and the watcher's test seam. */
const setup = async ({ config = {}, ctxPatch = {} } = {}) => {
  const f = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, ...config } });
  Object.assign(f.ctx, ctxPatch);
  const clock = { t: Date.now(), tick: 0 };
  const seam = await activate(f.ctx, { pollMs: 1, now: () => clock.t });
  const result = f.rec.tools.get("loremax_result");
  const run = async (args, call = CALL) => JSON.parse((await result.handler(args, call)).content[0].text);
  const track = (over = {}) =>
    f.ctx.jobs.track({ workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: null, externalId: "501", model: "flux-portrait", label: "hero", ...over });
  return { ...f, clock, run, track, watchOnce: seam.watchOnce, art: f.ctx.paths.workspaceArtifacts("studio") };
};

/** /check route that answers `replies` in order (the last repeats) and advances the fake clock. */
const checkRoute = (s, replies, id = "501") => {
  let i = 0;
  return ["POST", `/api/v2/generations/${id}/check`, () => {
    s.clock.t += s.clock.tick;
    const r = replies[Math.min(i++, replies.length - 1)];
    return typeof r === "function" ? r() : r;
  }];
};

let restore = () => {};
afterEach(() => restore());

test("loremax_result: a finished job returns its stored result without any request", async () => {
  const s = await setup();
  const id = s.track();
  s.ctx.jobs.settle(id, { status: "succeeded", result: { artifacts: ["task-9/flux-portrait-501.png"], tokensCost: 12 } });
  const f = mockFetch([]);
  restore = f.restore;
  const reply = await s.run({ generation_id: "501" });
  assert.equal(f.calls.length, 0);
  assert.equal(reply.status, "completed");
  assert.deepEqual(reply.artifacts, ["task-9/flux-portrait-501.png"]);
  assert.equal(reply.tokens_cost, 12);
});

test("loremax_result: a failed job returns its error without any request", async () => {
  const s = await setup();
  const id = s.track();
  s.ctx.jobs.settle(id, { status: "failed", error: "NSFW filter" });
  const f = mockFetch([]);
  restore = f.restore;
  assert.deepEqual(await s.run({ generation_id: "501" }), { generation_id: "501", status: "failed", error: "NSFW filter" });
  assert.equal(f.calls.length, 0);
});

test("loremax_result: a pending job is checked once and stays in progress", async () => {
  const s = await setup();
  s.track();
  const f = mockFetch([checkRoute(s, [{ status: "checking" }])]);
  restore = f.restore;
  const reply = await s.run({ generation_id: "501" });
  assert.equal(reply.status, "in_progress");
  assert.equal(reply.generation_id, "501");
  assert.match(reply.hint, /WOKEN/);
  assert.equal(f.calls.length, 1);
  assert.equal(s.jobs[0].status, "running");
});

test("loremax_result: with wait_s it polls until completed, saves and settles (workflow from the job row)", async () => {
  const s = await setup();
  s.clock.tick = 1_000;
  s.track();
  const f = mockFetch([checkRoute(s, [{ status: "pending" }, DONE]), PNG]);
  restore = f.restore;
  const reply = await s.run({ generation_id: "501", wait_s: 30 }, { ...CALL, taskId: undefined });
  assert.equal(reply.status, "completed");
  assert.equal(reply.workflow, "flux-portrait");
  // the task folder comes from the job row when the calling turn has none
  assert.deepEqual(reply.artifacts, ["task-9/flux-portrait-501.png"]);
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/flux-portrait-501.png"), "utf8"), "PNG");
  assert.equal(s.rec.annotate[0].meta.generation.workflow, "flux-portrait");
  assert.equal(s.jobs[0].status, "succeeded");
  assert.deepEqual(s.jobs[0].result.artifacts, ["task-9/flux-portrait-501.png"]);
});

test("loremax_result: after a timed-out loremax_generate it reuses the in-memory inputs and references", async () => {
  const s = await setup();
  s.clock.tick = 5_000;
  const ref = path.join(s.art, "studio-references/ref.png");
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(ref, "REF");
  let done = false;
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => ({ generationId: 501, tokensCost: 7, async: true })],
    checkRoute(s, [() => (done ? DONE : { status: "pending" })]),
    PNG,
  ]);
  restore = f.restore;
  const gen = s.rec.tools.get("loremax_generate");
  const first = JSON.parse((await gen.handler({ workflow_id: "flux-portrait", inputs: { prompt: "rain" }, references: ["artifacts/studio-references/ref.png"], wait_s: 10 }, CALL)).content[0].text);
  assert.equal(first.status, "in_progress");
  done = true;
  const reply = await s.run({ generation_id: "501" });
  assert.equal(reply.status, "completed");
  assert.equal(reply.tokens_cost, 7);
  const g = s.rec.annotate[0].meta.generation;
  assert.deepEqual(g.params, { prompt: "rain", image_urls: ["artifacts/studio-references/ref.png"] });
});

test("watcher: finishes a pending job, settles it and wakes the agent with the artifacts", async () => {
  const s = await setup();
  s.track();
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "succeeded");
  assert.ok(fs.existsSync(path.join(s.art, "task-9/flux-portrait-501.png")));
  assert.equal(s.rec.wakes.length, 1);
  const w = s.rec.wakes[0];
  assert.equal(w.workspace, "studio");
  assert.equal(w.agent, "illustrator");
  assert.equal(w.sessionKey, "sess-1");
  assert.equal(w.key, `loremax-job:${s.jobs[0].id}`);
  assert.match(w.prompt, /LoreMax generation 501 \(flux-portrait — hero\) finished: artifacts\/task-9\/flux-portrait-501\.png/);
  assert.equal(s.rec.usage[0].model, "flux-portrait");
  // one spend per generation on the host, however often a crash makes it finish again
  assert.equal(s.rec.usage[0].ref, "501");
});

test("watcher: a Text workflow's result.textContent from /check is saved as .md and woken", async () => {
  const s = await setup();
  s.track({ model: "story" });
  const f = mockFetch([checkRoute(s, [{ status: "completed", result: { originalUrls: [], previewUrls: [], contentTypes: [], textContent: "The end." } }])]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(fs.readFileSync(path.join(s.art, "task-9/story-501.md"), "utf8"), "The end.");
  assert.match(s.rec.wakes[0].prompt, /finished: artifacts\/task-9\/story-501\.md/);
  // a /check result is never looked up again
  assert.equal(f.calls.length, 1);
  assert.equal(s.rec.usage[0].ref, "501");
});

test("watcher after a restart: provenance and cost come from the job row's track() params", async () => {
  const s = await setup();
  s.track({ label: "x", params: { inputs: { prompt: "rain" }, references: ["artifacts/r.png"], tokensCost: 9, note: "hero" } });
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  await s.watchOnce();
  const g = s.rec.annotate[0].meta.generation;
  assert.deepEqual(g.params, { prompt: "rain", image_urls: ["artifacts/r.png"] });
  assert.match(s.rec.annotate[0].meta.description, /· hero$/);
  assert.equal(s.rec.usage[0].units, 9);
});

test("watcher: a still-running job is left alone, a failed one is settled and the agent woken", async () => {
  const s = await setup();
  s.track();
  s.track({ externalId: "502", label: "" });
  const f = mockFetch([
    checkRoute(s, [{ status: "pending" }]),
    checkRoute(s, [jsonResponse({ status: "failed", error: "GPU OOM", errorType: "runtime" }, 500)], "502"),
  ]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "running");
  assert.equal(s.jobs[1].status, "failed");
  assert.equal(s.jobs[1].error, "GPU OOM (runtime)");
  assert.equal(s.rec.wakes.length, 1);
  assert.match(s.rec.wakes[0].prompt, /502 .*FAILED: GPU OOM/);
});

test("watcher: gives up a job still pending after 6h, and logs (never throws) transient errors", async () => {
  const s = await setup();
  s.track();
  s.track({ externalId: "502" });
  s.jobs[0].createdAt = new Date(s.clock.t - 7 * 3_600_000).toISOString();
  const f = mockFetch([
    checkRoute(s, [{ status: "pending" }]),
    ["POST", "/api/v2/generations/502/check", () => new Response("bad gateway", { status: 502 })],
  ]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "failed");
  assert.equal(s.jobs[0].error, "gave up after 6h");
  assert.match(s.rec.wakes[0].prompt, /6h/);
  assert.equal(s.jobs[1].status, "running");
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /loremax job 502/.test(l.msg)));
});

test("watcher: a job past 6h that completed while Bridex was down is still saved, not given up", async () => {
  const s = await setup();
  s.track();
  s.jobs[0].createdAt = new Date(s.clock.t - 9 * 3_600_000).toISOString();
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "succeeded");
  assert.ok(fs.existsSync(path.join(s.art, "task-9/flux-portrait-501.png")));
  assert.equal(s.rec.usage.length, 1);
  assert.match(s.rec.wakes[0].prompt, /finished/);
});

test("watcher: a job past 6h whose /check keeps failing is given up", async () => {
  const s = await setup();
  s.track();
  s.jobs[0].createdAt = new Date(s.clock.t - 7 * 3_600_000).toISOString();
  const f = mockFetch([checkRoute(s, [new Response("bad gateway", { status: 502 })])]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "failed");
  assert.equal(s.jobs[0].error, "gave up after 6h");
  assert.match(s.rec.wakes[0].prompt, /6h/);
});

test("watcher: arms an interval that is cleared on shutdown", async () => {
  const { setInterval: realSet, clearInterval: realClear } = globalThis;
  const armed = [];
  const cleared = [];
  globalThis.setInterval = (...a) => {
    const t = realSet(...a);
    armed.push(t);
    return t;
  };
  globalThis.clearInterval = (t) => {
    cleared.push(t);
    realClear(t);
  };
  try {
    const s = await setup();
    assert.equal(armed.length, 1);
    assert.equal(s.rec.shutdown.length, 1);
    s.rec.shutdown[0]();
    assert.deepEqual(cleared, armed);
  } finally {
    Object.assign(globalThis, { setInterval: realSet, clearInterval: realClear });
  }
});

test("check: no key, a working key with a balance, an empty balance, a refused key", async () => {
  const none = fakeCtx({ config: { api_key: "", base_url: BASE } });
  const restoreEnv = process.env.LOREMAX_API_KEY;
  delete process.env.LOREMAX_API_KEY;
  try {
    await activate(none.ctx);
    assert.deepEqual(await none.rec.checks[0](), { ok: false, message: "no key: LOREMAX_API_KEY is not set" });
  } finally {
    if (restoreEnv !== undefined) process.env.LOREMAX_API_KEY = restoreEnv;
  }

  const s = await setup();
  const check = s.rec.checks[0];
  let reply = mcpResult({ limit: 1000, used: 250, remaining: 750 });
  const f = mockFetch([["POST", "/api/mcp", (req) => {
    assert.equal(req.json.params.name, "get_balance");
    return reply;
  }]]);
  restore = f.restore;
  assert.deepEqual(await check(), { ok: true, message: "key works · 750 tk left" });
  reply = mcpResult({ limit: 1000, used: 1000, remaining: 0 });
  assert.deepEqual(await check(), { ok: false, message: "key works, but the balance is empty — top up LoreMax" });
  reply = new Response("Invalid API key", { status: 401 });
  assert.deepEqual(await check(), { ok: false, message: "LoreMax refused the key (401)" });
});

test("stat tile: balance share, low flag, cached for 60 s, [] on error", async () => {
  const s = await setup();
  const stat = s.rec.stats[0];
  let reply = () => mcpResult({ limit: 1000, used: 250, remaining: 750 });
  const f = mockFetch([["POST", "/api/mcp", () => reply()]]);
  restore = f.restore;
  assert.deepEqual(await stat(), [{ label: "LoreMax balance", value: "750 tk", sub: "balance", balance: 0.75, low: false }]);
  s.clock.t += 30_000;
  await stat();
  assert.equal(f.calls.length, 1);

  s.clock.t += 31_000;
  reply = () => mcpResult({ limit: 1000, used: 950, remaining: 50 });
  const [tile] = await stat();
  assert.equal(f.calls.length, 2);
  assert.equal(tile.low, true);
  assert.equal(tile.sub, "running out");

  s.clock.t += 61_000;
  reply = () => new Response("down", { status: 503 });
  assert.deepEqual(await stat(), []);
});

test("after a restart the token spend and note come back from the job label", async () => {
  const s = await setup();
  s.track({ label: "hero · 12 tk" });
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.rec.usage[0].units, 12);
  assert.match(s.rec.annotate[0].meta.description, /· hero$/);
  assert.deepEqual(s.jobs[0].result.tokensCost, 12);
});

test("loremax_result: another workspace's generation and unknown ids are refused", async () => {
  const s = await setup();
  s.track({ workspace: "other" });
  const f = mockFetch([]);
  restore = f.restore;
  await assert.rejects(s.run({ generation_id: "501" }), /not started from this workspace/);
  await assert.rejects(s.run({ generation_id: "502" }), /not started from this workspace/);
  assert.equal(f.calls.length, 0);
});

test("loremax_result while the watcher is saving the same generation: in_progress, one download, one spend", async () => {
  const s = await setup();
  s.track();
  let release;
  const gate = new Promise((r) => (release = r));
  const f = mockFetch([
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, async () => {
      await gate;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
  ]);
  restore = f.restore;
  const watching = s.watchOnce();
  await new Promise((r) => setTimeout(r, 10));
  const replying = s.run({ generation_id: "501" });
  release();
  const [reply] = await Promise.all([replying, watching]);
  assert.equal(reply.status, "in_progress");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/out.png")).length, 1);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.jobs[0].status, "succeeded");
});

test("watcher: a job a tool call finished while the pass was busy elsewhere is not saved, billed or woken again", async () => {
  const s = await setup();
  s.track({ externalId: "501" });
  s.track({ externalId: "502", label: "second" });
  let release;
  const gate = new Promise((r) => (release = r));
  const B = { status: "completed", result: { originalUrls: [`${CDN}/b.png`], previewUrls: [], contentTypes: ["image/png"] } };
  const f = mockFetch([
    checkRoute(s, [DONE], "501"),
    checkRoute(s, [B], "502"),
    ["GET", `${CDN}/out.png`, async () => {
      await gate;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
    ["GET", `${CDN}/b.png`, () => new Response("B", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  // the pass reads [501, 502] and sits on 501's download while loremax_result finishes 502
  const watching = s.watchOnce();
  await new Promise((r) => setTimeout(r, 10));
  const reply = await s.run({ generation_id: "502", wait_s: 5 });
  assert.equal(reply.status, "completed");
  release();
  await watching;
  assert.equal(f.calls.filter((c) => c.url.includes("/502/check")).length, 1);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/b.png")).length, 1);
  assert.equal(s.rec.usage.length, 2);
  assert.equal(s.rec.wakes.length, 1);
  assert.match(s.rec.wakes[0].prompt, /501/);
});

test("on a core without find(), loremax_result after a restart settles the job: the watcher does not save, bill or wake again", async () => {
  const s = await setup();
  delete s.ctx.jobs.find;
  s.track();
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  const reply = await s.run({ generation_id: "501" });
  assert.equal(reply.status, "completed");
  assert.equal(s.jobs[0].status, "succeeded");
  await s.watchOnce();
  assert.equal(f.calls.filter((c) => c.url.includes("/check")).length, 1);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.wakes.length, 0);
});

test("on a core without find(), the watcher skips a job a tool call finished while the pass was busy elsewhere", async () => {
  const s = await setup();
  delete s.ctx.jobs.find;
  s.track({ externalId: "501" });
  s.track({ externalId: "502", label: "second" });
  let release;
  const gate = new Promise((r) => (release = r));
  const B = { status: "completed", result: { originalUrls: [`${CDN}/b.png`], previewUrls: [], contentTypes: ["image/png"] } };
  const f = mockFetch([
    checkRoute(s, [DONE], "501"),
    checkRoute(s, [B], "502"),
    ["GET", `${CDN}/out.png`, async () => {
      await gate;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
    ["GET", `${CDN}/b.png`, () => new Response("B", { headers: { "content-type": "image/png" } })],
  ]);
  restore = f.restore;
  const watching = s.watchOnce();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await s.run({ generation_id: "502", wait_s: 5 })).status, "completed");
  release();
  await watching;
  assert.equal(f.calls.filter((c) => c.url.includes("/502/check")).length, 1);
  assert.equal(s.rec.usage.length, 2);
  assert.equal(s.rec.wakes.length, 1);
});

test("a re-activated plugin's watcher leaves alone a generation the old instance's tool call is saving", async () => {
  const s = await setup();
  s.track();
  // update / dashboard toggle: activate() runs again on the same host while the old tool call polls
  const fresh = await activate(s.ctx, { pollMs: 1, now: () => s.clock.t });
  let release;
  const gate = new Promise((r) => (release = r));
  const f = mockFetch([
    checkRoute(s, [DONE]),
    ["GET", `${CDN}/out.png`, async () => {
      await gate;
      return new Response("PNG", { headers: { "content-type": "image/png" } });
    }],
  ]);
  restore = f.restore;
  const replying = s.run({ generation_id: "501", wait_s: 5 });
  await new Promise((r) => setTimeout(r, 10));
  const watching = fresh.watchOnce();
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [reply] = await Promise.all([replying, watching]);
  assert.equal(reply.status, "completed");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/out.png")).length, 1);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.wakes.length, 0);
});

test("watcher: a jobs-table error is logged, not thrown out of the interval", async () => {
  const s = await setup({ ctxPatch: {} });
  s.ctx.jobs.pending = () => { throw new Error("SQLITE_BUSY"); };
  await s.watchOnce();
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /SQLITE_BUSY/.test(l.msg)));
});

test("loremax_result: a failed job of another workspace is refused (the host's find() has no workspace)", async () => {
  const s = await setup();
  // like the real host: find() returns only id, status, result and error
  const find = s.ctx.jobs.find;
  s.ctx.jobs.find = (id) => {
    const j = find(id);
    return j && { id: j.id, status: j.status, result: j.result, error: j.error };
  };
  s.track({ workspace: "other" });
  const f = mockFetch([checkRoute(s, [{ status: "failed", error: "NSFW filter" }])]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "failed");
  await assert.rejects(s.run({ generation_id: "501" }), /not started from this workspace/);
  const own = await s.run({ generation_id: "501" }, { ...CALL, workspace: "other" });
  assert.equal(own.status, "failed");
});

test("watcher: outputs that could not be downloaded are named in the wake prompt", async () => {
  const s = await setup();
  s.track();
  const f = mockFetch([checkRoute(s, [DONE]), ["GET", `${CDN}/out.png`, () => new Response("nope", { status: 503 })]]);
  restore = f.restore;
  await s.watchOnce();
  const { prompt } = s.rec.wakes[0];
  assert.match(prompt, new RegExp(`still on LoreMax's CDN: ${CDN}/out\\.png`));
  assert.doesNotMatch(prompt, /returned no files/);
});

test("watcher: a submit: placeholder left by a dead process is settled failed and woken once, never checked", async () => {
  const s = await setup();
  s.track({ externalId: "submit:7d3c", model: "kling", label: "hero", params: { submitting: true, mode: "rest", workflow: "kling", note: "hero" } });
  // the restarted process: a fresh activation whose inFlight never held the placeholder
  globalThis[Symbol.for("bridex.loremax.inFlight")]?.delete("submit:7d3c");
  const fresh = await activate(s.ctx, { pollMs: 1, now: () => s.clock.t });
  const f = mockFetch([]);
  restore = f.restore;
  await fresh.watchOnce();
  assert.equal(f.calls.length, 0);
  assert.equal(s.jobs[0].status, "failed");
  assert.match(s.jobs[0].error, /interrupted by a restart/);
  assert.equal(s.rec.wakes.length, 1);
  assert.equal(s.rec.wakes[0].sessionKey, "sess-1");
  assert.match(s.rec.wakes[0].prompt, /LoreMax kling \(hero\): the submission was interrupted by a restart; it may have been charged — check LoreMax history before running it again \(task task-9\)/);
  await fresh.watchOnce();
  assert.equal(s.rec.wakes.length, 1);
  // loremax_result does not treat it as a generation
  await assert.rejects(s.run({ generation_id: "submit:7d3c" }), /not started from this workspace/);
});

test("watcher: a submit: placeholder a running submission still holds is left alone", async () => {
  const s = await setup();
  s.track({ externalId: "submit:live", params: { submitting: true } });
  const inFlight = globalThis[Symbol.for("bridex.loremax.inFlight")];
  inFlight.add("submit:live");
  try {
    const f = mockFetch([]);
    restore = f.restore;
    await s.watchOnce();
    assert.equal(f.calls.length, 0);
    assert.equal(s.jobs[0].status, "running");
    assert.equal(s.rec.wakes.length, 0);
  } finally {
    inFlight.delete("submit:live");
  }
});

test("loremax_result: wait_s 0 still does one check and saves a completed generation inline", async () => {
  const s = await setup();
  s.track();
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  const reply = await s.run({ generation_id: "501", wait_s: 0 });
  assert.equal(reply.status, "completed");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/check")).length, 1);
});

test("restart in profile mode: the watcher and loremax_result finish a profile job from its persisted params", async () => {
  const params = {
    mode: "profile",
    tool: "masked_edit",
    arguments: { text: "fix the sky", source: "src.png" },
    references: ["src.png"],
    tokensCost: 7,
    note: "sky",
    identity: { workflowId: 7, visualId: "masked-edit", title: "masked_edit", category: "Image", contentType: "image", pipeline: false },
    profile: "AbCdEfGh12345678",
  };
  const expectParams = { text: "fix the sky", source: "src.png", tool: "masked_edit", profile: "AbCdEfGh12345678", image_urls: ["src.png"] };

  // a fresh activation (the in-memory job is gone): the watcher reads the row's params
  const s = await setup({ config: { profile_url: "AbCdEfGh12345678" } });
  s.track({ model: "masked-edit", label: "sky · 7 tk", params });
  const f = mockFetch([checkRoute(s, [DONE]), PNG]);
  restore = f.restore;
  await s.watchOnce();
  // REST check only, never the profile
  assert.ok(f.calls.every((c) => !c.url.includes("/api/mcp")));
  assert.equal(s.rec.annotate[0].meta.generation.workflow, "masked-edit");
  assert.deepEqual(s.rec.annotate[0].meta.generation.params, expectParams);
  assert.match(s.rec.annotate[0].meta.description, /· sky$/);
  assert.equal(s.rec.usage.length, 1);
  assert.deepEqual({ model: s.rec.usage[0].model, units: s.rec.usage[0].units, ref: s.rec.usage[0].ref }, { model: "masked-edit", units: 7, ref: "501" });
  assert.match(s.rec.wakes[0].prompt, /finished: artifacts\/task-9\/masked-edit-501\.png/);
  assert.equal(s.jobs[0].status, "succeeded");
  restore();

  const s2 = await setup({ config: { profile_url: "AbCdEfGh12345678" } });
  s2.track({ model: "masked-edit", label: "sky · 7 tk", params });
  restore = mockFetch([checkRoute(s2, [DONE]), PNG]).restore;
  const r = await s2.run({ generation_id: "501" });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.artifacts, ["task-9/masked-edit-501.png"]);
  assert.deepEqual(s2.rec.annotate[0].meta.generation.params, expectParams);
  assert.equal(s2.rec.usage[0].units, 7);
  assert.equal(s2.jobs[0].status, "succeeded");
  // settled: the watcher does not save, bill or wake again
  await s2.watchOnce();
  assert.equal(s2.rec.usage.length, 1);
  assert.equal(s2.rec.wakes.length, 0);
});
