import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import activate, { createClient } from "../index.mjs";
import { fakeCtx, mockFetch } from "./helpers.mjs";

const BASE = "https://lm.test";
const CDN = "https://cdn.lm.test";
const CALL = { workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: "run-1" };
const EXECUTE = { generationId: 501, status: "pending", tokensCost: 7, async: true };
const EMPTY = { status: "completed", result: { originalUrls: [], previewUrls: [], contentTypes: [] } };
const DONE = { status: "completed", result: { originalUrls: [`${CDN}/out.png`], previewUrls: [], contentTypes: ["image/png"] } };
const PNG = ["GET", `${CDN}/out.png`, () => new Response("PNG", { headers: { "content-type": "image/png" } })];

const setup = async () => {
  const f = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const seam = await activate(f.ctx, { pollMs: 1, now: () => 0 });
  const run = async (args) => JSON.parse((await f.rec.tools.get("loremax_generate").handler(args, CALL)).content[0].text);
  return { ...f, run, watchOnce: seam.watchOnce };
};

let restore = () => {};
afterEach(() => restore());

test("activate wires the three tools, the check, the balance tile and the watcher", async () => {
  const s = await setup();
  assert.deepEqual([...s.rec.tools.keys()].sort(), ["loremax_generate", "loremax_result", "loremax_workflows"]);
  assert.equal(s.rec.checks.length, 1);
  assert.equal(s.rec.stats.length, 1);
  assert.equal(s.rec.shutdown.length, 1);
  assert.equal(typeof s.watchOnce, "function");
});

test("empty originalUrls and previewUrls: the reply says no files, the job settles succeeded with artifacts []", async () => {
  const s = await setup();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    ["POST", "/api/v2/generations/501/check", () => EMPTY],
  ]);
  restore = f.restore;
  const reply = await s.run({ workflow_id: "flux-portrait", inputs: { prompt: "p" } });
  assert.equal(reply.status, "completed");
  assert.deepEqual(reply.artifacts, []);
  assert.match(reply.hint, /no files/);
  assert.equal(s.jobs[0].status, "succeeded");
  assert.deepEqual(s.jobs[0].result, { workspace: "studio", artifacts: [], tokensCost: 7 });
  assert.equal(s.rec.mirror.length, 0);
  assert.equal(s.rec.annotate.length, 0);
  // the tokens were spent all the same
  assert.equal(s.rec.usage[0].units, 7);
});

test("empty outputs through the watcher: settled succeeded and the wake prompt says so", async () => {
  const s = await setup();
  s.ctx.jobs.track({ workspace: "studio", agent: "illustrator", taskId: "task-9", sessionKey: "sess-1", runId: null, externalId: "501", model: "w", label: "" });
  const f = mockFetch([["POST", "/api/v2/generations/501/check", () => EMPTY]]);
  restore = f.restore;
  await s.watchOnce();
  assert.equal(s.jobs[0].status, "succeeded");
  assert.deepEqual(s.jobs[0].result.artifacts, []);
  assert.match(s.rec.wakes[0].prompt, /LoreMax returned no files/);
});

test("workflow_id: a numeric id and a visual id are both sent as given and name the outputs", async () => {
  for (const [id, file] of [["12", "task-9/12-501.png"], ["Flux Portrait v2", "task-9/flux-portrait-v2-501.png"]]) {
    const s = await setup();
    const f = mockFetch([
      ["POST", "/api/v2/workflow/execute", () => EXECUTE],
      ["POST", "/api/v2/generations/501/check", () => DONE],
      PNG,
    ]);
    restore = f.restore;
    const reply = await s.run({ workflow_id: id, inputs: { prompt: "p" } });
    assert.equal(f.calls[0].json.workflowId, id);
    assert.deepEqual(reply.artifacts, [file]);
    assert.equal(s.jobs[0].model, id);
    assert.equal(s.rec.annotate[0].meta.generation.workflow, id);
    restore();
  }
});

test("inputs without prompt: the job label and provenance note come from note; neither → empty label", async () => {
  const s = await setup();
  const f = mockFetch([
    ["POST", "/api/v2/workflow/execute", () => EXECUTE],
    ["POST", "/api/v2/generations/501/check", () => DONE],
    PNG,
  ]);
  restore = f.restore;
  await s.run({ workflow_id: "upscale", inputs: { scale: 2 }, note: "hero upscale" });
  assert.equal(s.jobs[0].label, "hero upscale · 7 tk");
  assert.match(s.rec.annotate[0].meta.description, /· hero upscale$/);

  await s.run({ workflow_id: "upscale", inputs: { scale: 2, prompt: 42 } });
  assert.equal(s.jobs[1].label, "7 tk");
});

test("plugin.yaml: every config_schema property has a default in createClient", () => {
  const yaml = fs.readFileSync(new URL("../plugin.yaml", import.meta.url), "utf8");
  const props = yaml.split("\n  properties:\n")[1];
  const keys = [...props.matchAll(/^ {4}([a-z_]+):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ["api_key", "base_url", "default_wait_s", "usd_per_token"]);
  const { cfg } = createClient(fakeCtx().ctx);
  for (const k of keys) assert.notEqual(cfg[k], undefined, `${k} has no default`);
  assert.match(yaml, /^name: loremax$/m);
  assert.match(yaml, /^entry: index\.mjs$/m);
  // the manifest default and the code default agree
  assert.match(yaml, /default_wait_s:[\s\S]*?default: 180/);
  assert.equal(cfg.default_wait_s, 180);
});
