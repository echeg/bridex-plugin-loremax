import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient, createOutputs } from "../index.mjs";
import { fakeCtx, mockFetch } from "./helpers.mjs";

const CDN = "https://cdn.lm.test";
const CALL = { workspace: "studio", agent: "illustrator", taskId: "task-7" };

const setup = ({ config = {}, downloadCap } = {}) => {
  const f = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: "https://lm.test", ...config } });
  const out = createOutputs(f.ctx, createClient(f.ctx), downloadCap ? { downloadCap } : {});
  const read = (rel) => fs.readFileSync(path.join(f.ctx.paths.workspaceArtifacts(CALL.workspace), rel), "utf8");
  return { ...f, ...out, read };
};

const file = (body, type = "application/octet-stream", headers = {}) =>
  new Response(body, { status: 200, headers: { "content-type": type, ...headers } });

let restore = () => {};
afterEach(() => restore());

test("finish: two outputs named by contentTypes, provenance, mirror, usage, settle", async () => {
  const f = mockFetch([
    ["GET", `${CDN}/a`, () => file("A")],
    ["GET", `${CDN}/b`, () => file("B")],
  ]);
  restore = f.restore;
  const s = setup({ config: { usd_per_token: 0.01 } });
  const trackedId = s.ctx.jobs.track({ externalId: "gen-42", model: "Flux Portrait" });
  const reply = await s.finish(CALL, {
    generationId: "gen-42",
    workflow: "Flux Portrait",
    inputs: { prompt: "a knight", aspect: "1:1" },
    references: ["artifacts/studio-references/knight.png", "artifacts/studio-references/castle.jpg"],
    tokensCost: 30,
    trackedId,
    note: "hero portrait",
  }, { status: "completed", result: { originalUrls: [`${CDN}/a`, `${CDN}/b`], previewUrls: [], contentTypes: ["image/png", "image/webp"] } });

  const rels = ["task-7/flux-portrait-gen-42-1.png", "task-7/flux-portrait-gen-42-2.webp"];
  assert.deepEqual(reply.artifacts, rels);
  assert.equal(s.read(rels[0]), "A");
  assert.equal(s.read(rels[1]), "B");

  assert.equal(s.rec.annotate.length, 2);
  const meta = s.rec.annotate[0].meta;
  assert.equal(meta.agent, "illustrator");
  assert.equal(meta.taskId, "task-7");
  assert.equal(meta.action, "generated");
  assert.equal(meta.description, "LoreMax Flux Portrait · generation gen-42 · hero portrait");
  assert.deepEqual(meta.generation, {
    provider: "LoreMax",
    workflow: "Flux Portrait",
    params: { prompt: "a knight", aspect: "1:1", image_urls: ["artifacts/studio-references/knight.png", "artifacts/studio-references/castle.jpg"] },
    externalId: "gen-42",
    costUsd: 0.3,
  });
  assert.deepEqual(s.rec.mirror, [{ workspace: "studio", rels }]);

  assert.deepEqual(s.rec.usage, [{
    workspace: "studio", agent: "illustrator", kind: "loremax", model: "Flux Portrait",
    costUsd: 0.3, units: 30, unit: "tk", taskId: "task-7",
  }]);
  assert.equal(s.jobs[0].status, "succeeded");
  assert.deepEqual(s.jobs[0].result, { artifacts: rels, tokensCost: 30 });

  assert.equal(reply.generation_id, "gen-42");
  assert.equal(reply.status, "completed");
  assert.equal(reply.tokens_cost, 30);
  assert.equal(reply.cost_usd, 0.3);
  assert.match(reply.hint, /\[media: artifacts\/<path>\]/);
});

test("finish: without usd_per_token spend is tokens only and params carry no image_urls", async () => {
  const f = mockFetch([["GET", `${CDN}/one`, () => file("X", "image/jpeg")]]);
  restore = f.restore;
  const s = setup();
  const reply = await s.finish({ workspace: "studio", agent: "a" }, { generationId: 7, workflow: "12", inputs: { prompt: "p" }, tokensCost: 5 },
    { result: { originalUrls: [`${CDN}/one`] } });
  // a single output has no -N suffix; no taskId → the loremax folder; Content-Type decides the extension
  assert.deepEqual(reply.artifacts, ["loremax/12-7.jpg"]);
  assert.equal(s.rec.usage[0].costUsd, 0);
  assert.equal(s.rec.usage[0].units, 5);
  assert.equal(reply.cost_usd, undefined);
  const g = s.rec.annotate[0].meta.generation;
  assert.deepEqual(g.params, { prompt: "p" });
  assert.equal(g.costUsd, undefined);
  assert.equal(g.externalId, "7");
  assert.equal(s.rec.annotate[0].meta.description, "LoreMax 12 · generation 7");
});

test("saveOutputs: falls back to previewUrls, then the URL path for the extension", async () => {
  const f = mockFetch([["GET", `${CDN}/p/clip.mp4`, () => file("V")]]);
  restore = f.restore;
  const s = setup();
  const rels = await s.saveOutputs(CALL, "kling", "g1", { originalUrls: [], previewUrls: [`${CDN}/p/clip.mp4`] }, "", {});
  assert.deepEqual(rels, ["task-7/kling-g1.mp4"]);
  assert.equal(f.calls[0].url, `${CDN}/p/clip.mp4`);
});

test("saveOutputs: no URLs at all → nothing saved, no mirror", async () => {
  const s = setup();
  assert.deepEqual(await s.saveOutputs(CALL, "w", "g", { originalUrls: [], previewUrls: [] }, "", {}), []);
  assert.deepEqual(s.rec.mirror, []);
});

test("saveOutputs: a failed download is skipped with a warning", async () => {
  const f = mockFetch([
    ["GET", `${CDN}/gone`, () => new Response("nope", { status: 404 })],
    ["GET", `${CDN}/ok`, () => file("OK", "image/png")],
  ]);
  restore = f.restore;
  const s = setup();
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/gone`, `${CDN}/ok`] }, "", {});
  assert.deepEqual(rels, ["task-7/w-g-2.png"]);
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /download failed \(404\)/.test(l.msg)));
});

test("saveOutputs: files over the cap stay on the CDN", async () => {
  const f = mockFetch([
    ["GET", `${CDN}/big`, () => file("0123456789", "image/png")],
    ["GET", `${CDN}/declared`, () => file("01", "image/png", { "content-length": "999999" })],
    ["GET", `${CDN}/small`, () => file("01", "image/png")],
  ]);
  restore = f.restore;
  const s = setup({ downloadCap: 5 });
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/big`, `${CDN}/declared`, `${CDN}/small`] }, "", {});
  assert.deepEqual(rels, ["task-7/w-g-3.png"]);
  assert.equal(s.rec.logs.filter((l) => /exceeds the/.test(l.msg)).length, 2);
});

test("resolveLocal: artifacts/ and workdir paths resolve, escapes and missing files throw", () => {
  const s = setup();
  const art = s.ctx.paths.workspaceArtifacts("studio");
  const work = s.ctx.paths.workspaceWorkdir("studio");
  fs.mkdirSync(path.join(art, "refs"), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(art, "refs", "a.png"), "a");
  fs.writeFileSync(path.join(work, "b.png"), "b");
  fs.writeFileSync(path.join(s.dir, "outside.png"), "x");

  assert.equal(s.resolveLocal("studio", "artifacts/refs/a.png"), path.join(art, "refs", "a.png"));
  assert.equal(s.resolveLocal("studio", "b.png"), path.join(work, "b.png"));
  assert.throws(() => s.resolveLocal("studio", "../outside.png"), /outside your workspace/);
  assert.throws(() => s.resolveLocal("studio", path.join(s.dir, "outside.png")), /outside your workspace/);
  assert.throws(() => s.resolveLocal("studio", "artifacts/../../outside.png"), /outside your workspace/);
  assert.throws(() => s.resolveLocal("studio", "artifacts/refs/missing.png"), /file not found/);
});
