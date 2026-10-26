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
    costUsd: 0.3, units: 30, unit: "tk", taskId: "task-7", ref: "gen-42",
  }]);
  assert.equal(s.jobs[0].status, "succeeded");
  assert.deepEqual(s.jobs[0].result, { workspace: "studio", artifacts: rels, tokensCost: 30 });

  assert.equal(reply.generation_id, "gen-42");
  assert.equal(reply.status, "completed");
  assert.equal(reply.tokens_cost, 30);
  assert.equal(reply.cost_usd, 0.3);
  assert.match(reply.hint, /\[media: artifacts\/<path>\]/);
});

test("finish: usd_per_token 0 records tokens only and params carry no image_urls", async () => {
  const f = mockFetch([["GET", `${CDN}/one`, () => file("X", "image/jpeg")]]);
  restore = f.restore;
  const s = setup({ config: { usd_per_token: 0 } });
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
  assert.deepEqual(rels, { artifacts: ["task-7/kling-g1.mp4"], skipped: [] });
  assert.equal(f.calls[0].url, `${CDN}/p/clip.mp4`);
});

test("saveOutputs: audio, 3D and transport-stream outputs get their own extensions, not .bin", async () => {
  const f = mockFetch([
    ["GET", `${CDN}/a`, () => file("A", "audio/mpeg")],
    ["GET", `${CDN}/m`, () => file("M")],
    ["GET", `${CDN}/v`, () => file("V", "video/mp2t; charset=binary")],
    ["GET", `${CDN}/w`, () => file("W", "audio/wav")],
    ["GET", `${CDN}/u`, () => file("U")],
  ]);
  restore = f.restore;
  const s = setup();
  const rels = await s.saveOutputs(CALL, "w", "g", {
    originalUrls: [`${CDN}/a`, `${CDN}/m`, `${CDN}/v`, `${CDN}/w`, `${CDN}/u`],
    contentTypes: ["", "model/gltf-binary", "", "", "model/vnd.usdz+zip"],
  }, "", {});
  assert.deepEqual(rels.artifacts, ["task-7/w-g-1.mp3", "task-7/w-g-2.glb", "task-7/w-g-3.ts", "task-7/w-g-4.wav", "task-7/w-g-5.usdz"]);
});

test("saveOutputs: a Text workflow's text is saved as .md with provenance, next to any media", async () => {
  const f = mockFetch([["GET", `${CDN}/img`, () => file("I", "image/png")]]);
  restore = f.restore;
  const s = setup();
  const only = await s.saveOutputs(CALL, "story", "g1", { originalUrls: [], textContent: "# Chapter\nonce upon" }, "draft", { workflow: "Story" });
  assert.deepEqual(only, { artifacts: ["task-7/story-g1.md"], skipped: [] });
  assert.equal(s.read("task-7/story-g1.md"), "# Chapter\nonce upon");
  assert.equal(s.rec.annotate[0].rel, "task-7/story-g1.md");
  assert.equal(s.rec.annotate[0].meta.description, "LoreMax Story · generation g1 · draft");
  assert.deepEqual(s.rec.mirror[0], { workspace: "studio", rels: ["task-7/story-g1.md"] });
  // the MCP spelling, beside an image
  const both = await s.saveOutputs(CALL, "story", "g2", { originalUrls: [`${CDN}/img`], contentTypes: ["image/png"], text_content: "caption" }, "", {});
  assert.deepEqual(both.artifacts, ["task-7/story-g2.png", "task-7/story-g2.md"]);
  // whitespace only is no text
  assert.deepEqual(await s.saveOutputs(CALL, "story", "g3", { textContent: "  \n" }, "", {}), { artifacts: [], skipped: [] });
});

test("saveOutputs: no URLs at all → nothing saved, no mirror", async () => {
  const s = setup();
  assert.deepEqual(await s.saveOutputs(CALL, "w", "g", { originalUrls: [], previewUrls: [] }, "", {}), { artifacts: [], skipped: [] });
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
  assert.deepEqual(rels, { artifacts: ["task-7/w-g-2.png"], skipped: [`${CDN}/gone`] });
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
  assert.deepEqual(rels, { artifacts: ["task-7/w-g-3.png"], skipped: [`${CDN}/big`, `${CDN}/declared`] });
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

test("resolveLocal: a symlink inside the workspace pointing outside is refused", () => {
  const s = setup();
  const work = s.ctx.paths.workspaceWorkdir("studio");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(s.dir, "secret.png"), "x");
  fs.symlinkSync(path.join(s.dir, "secret.png"), path.join(work, "ref.png"));
  assert.throws(() => s.resolveLocal("studio", "ref.png"), /outside your workspace/);
});

test("resolveLocal: a workdir folder whose name merely ends in artifacts stays in the workdir", () => {
  const s = setup();
  const work = s.ctx.paths.workspaceWorkdir("studio");
  fs.mkdirSync(path.join(work, "old_artifacts"), { recursive: true });
  fs.writeFileSync(path.join(work, "old_artifacts", "ref.png"), "r");
  assert.equal(s.resolveLocal("studio", "old_artifacts/ref.png"), path.join(work, "old_artifacts", "ref.png"));
});

test("finish: outputs that could not be downloaded come back as left_on_cdn, in the reply and the job", async () => {
  const f = mockFetch([
    ["GET", `${CDN}/gone`, () => new Response("nope", { status: 503 })],
    ["GET", `${CDN}/ok`, () => file("OK", "image/png")],
  ]);
  restore = f.restore;
  const s = setup();
  const trackedId = s.ctx.jobs.track({ workspace: "studio", agent: "a", externalId: "9", model: "w", label: "" });
  const reply = await s.finish(CALL, { generationId: 9, workflow: "w", tokensCost: 3, trackedId }, { result: { originalUrls: [`${CDN}/gone`, `${CDN}/ok`] } });
  assert.deepEqual(reply.artifacts, ["task-7/w-9-2.png"]);
  assert.deepEqual(reply.left_on_cdn, [`${CDN}/gone`]);
  assert.match(reply.hint, /left_on_cdn/);
  assert.deepEqual(s.jobs[0].result.left_on_cdn, [`${CDN}/gone`]);
});

test("saveOutputs: a body that breaks mid-download is left on the CDN, the rest still saves", async () => {
  const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("connection reset")) }), { headers: { "content-type": "image/png" } });
  const f = mockFetch([
    ["GET", `${CDN}/broken`, broken],
    ["GET", `${CDN}/ok`, () => file("OK", "image/png")],
  ]);
  restore = f.restore;
  const s = setup();
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/broken`, `${CDN}/ok`] }, "", {});
  assert.deepEqual(rels, { artifacts: ["task-7/w-g-2.png"], skipped: [`${CDN}/broken`] });
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /download failed \(connection reset\)/.test(l.msg)));
});

test("saveOutputs: a symlink planted at the output name is replaced, its target untouched", async () => {
  const f = mockFetch([["GET", `${CDN}/ok`, () => file("OK", "image/png")]]);
  restore = f.restore;
  const s = setup();
  const outside = path.join(s.dir, "host.db");
  fs.writeFileSync(outside, "DB");
  const dir = path.join(s.ctx.paths.workspaceArtifacts(CALL.workspace), "task-7");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(outside, path.join(dir, "w-g.png"));
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/ok`] }, "", {});
  assert.deepEqual(rels, { artifacts: ["task-7/w-g.png"], skipped: [] });
  assert.equal(fs.readFileSync(outside, "utf8"), "DB");
  assert.equal(fs.lstatSync(path.join(dir, "w-g.png")).isSymbolicLink(), false);
  assert.equal(s.read("task-7/w-g.png"), "OK");
});

test("saveOutputs: a task folder symlinked outside the workspace is not written into", async () => {
  const f = mockFetch([["GET", `${CDN}/ok`, () => file("OK", "image/png")]]);
  restore = f.restore;
  const s = setup();
  const outside = path.join(s.dir, "elsewhere");
  fs.mkdirSync(outside);
  const art = s.ctx.paths.workspaceArtifacts(CALL.workspace);
  fs.mkdirSync(art, { recursive: true });
  fs.symlinkSync(outside, path.join(art, "task-7"));
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/ok`] }, "", {});
  assert.deepEqual(rels, { artifacts: [], skipped: [`${CDN}/ok`] });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("saveOutputs: an undeclared size over the cap is cancelled mid-stream, never buffered whole", async () => {
  let pulls = 0;
  let cancelled = false;
  const endless = () =>
    new Response(new ReadableStream({ pull: (c) => (pulls++, c.enqueue(new Uint8Array(4))), cancel: () => (cancelled = true) }), { headers: { "content-type": "image/png" } });
  const f = mockFetch([["GET", `${CDN}/endless`, endless]]);
  restore = f.restore;
  const s = setup({ downloadCap: 10 });
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/endless`] }, "", {});
  assert.deepEqual(rels, { artifacts: [], skipped: [`${CDN}/endless`] });
  assert.ok(cancelled);
  assert.ok(pulls <= 5);
});

test("finish: a local save error leaves that output on the CDN, spend is still recorded", async () => {
  const f = mockFetch([["GET", `${CDN}/ok`, () => file("OK", "image/png")]]);
  restore = f.restore;
  const s = setup();
  // the task folder's name is taken by a file: mkdir fails like a read-only or full disk would
  const art = s.ctx.paths.workspaceArtifacts("studio");
  fs.mkdirSync(art, { recursive: true });
  fs.writeFileSync(path.join(art, "task-7"), "not a folder");
  const reply = await s.finish(CALL, { generationId: 9, workflow: "w", tokensCost: 3, trackedId: null }, { result: { originalUrls: [`${CDN}/ok`] } });
  assert.deepEqual(reply.artifacts, []);
  assert.deepEqual(reply.left_on_cdn, [`${CDN}/ok`]);
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.rec.usage[0].units, 3);
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /not saved \(/.test(l.msg)));
});

test("finish: a text output that cannot be written throws, spend recorded, job left running", async () => {
  const s = setup();
  // the task folder's name is taken by a file: mkdir fails like a read-only or full disk would
  const art = s.ctx.paths.workspaceArtifacts("studio");
  fs.mkdirSync(art, { recursive: true });
  fs.writeFileSync(path.join(art, "task-7"), "not a folder");
  const trackedId = s.ctx.jobs.track({ externalId: "g9", model: "Story" });
  await assert.rejects(
    s.finish(CALL, { generationId: "g9", workflow: "Story", tokensCost: 3, trackedId }, { result: { textContent: "once upon" }, fromReply: true }),
    /generation g9 finished, but its text output was not saved \(/,
  );
  assert.equal(s.rec.usage.length, 1);
  assert.equal(s.jobs[0].status, "running");
  // once the folder is writable, the retried finish saves the text and settles
  fs.rmSync(path.join(art, "task-7"));
  const done = await s.finish(CALL, { generationId: "g9", workflow: "Story", tokensCost: 3, trackedId }, { result: { textContent: "once upon" }, fromReply: true });
  assert.deepEqual(done.artifacts, ["task-7/story-g9.md"]);
  assert.equal(s.jobs[0].status, "succeeded");
});

test("saveOutputs: a failing annotate keeps the saved file in the reply", async () => {
  const f = mockFetch([["GET", `${CDN}/ok`, () => file("OK", "image/png")]]);
  restore = f.restore;
  const s = setup();
  s.ctx.artifacts.annotate = () => {
    throw new Error("sidecar locked");
  };
  const rels = await s.saveOutputs(CALL, "w", "g", { originalUrls: [`${CDN}/ok`] }, "", {});
  assert.deepEqual(rels, { artifacts: ["task-7/w-g.png"], skipped: [] });
  assert.equal(s.read("task-7/w-g.png"), "OK");
  assert.ok(s.rec.logs.some((l) => /sidecar locked/.test(l.msg)));
});
