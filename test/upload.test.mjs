import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient, createOutputs, createProfileCatalog, createUploader } from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));
const CALL = { workspace: "ws", agent: "art", taskId: "t1" };
const MIB = 1024 * 1024;

let restore = () => {};
afterEach(() => restore());

/** A media argument in LoreMax's x-loremax-media v1 shape. */
const media = (mediaType, { cardinality = "single", formats, constraints = {}, role = "source", maxItems } = {}) => ({
  ...(cardinality === "array" ? { type: "array", items: { type: "string" }, ...(maxItems != null ? { maxItems } : {}) } : { type: "string" }),
  "x-loremax-media": { version: 1, mediaType, role, cardinality, acceptedFormats: formats, constraints },
});
/** A generation tool for the tools/list reply. */
const genTool = (name, properties, limits) => ({
  name,
  title: name,
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" }, ...properties, on_behalf_of: { type: "string" }, schema_revision: { type: "string", enum: [`rev-${name}`] } },
    required: ["schema_revision"],
    ...(limits ? { "x-loremax-limits": { version: 1, ...limits } } : {}),
  },
  _meta: { "loremax.ai/workflow": { version: 1, workflowId: 50, title: name, category: "Test" } },
});
const EXTRA_TOOLS = [
  genTool("voice_over", { voice: media("audio", { formats: ["mp4", "m4a", "mp3", "wav"] }) }),
  genTool("many_images", { images: media("image", { cardinality: "array", formats: ["png"] }) }),
  genTool("tight", {
    images: media("image", { cardinality: "array", formats: ["png"] }),
    mask: media("image", { formats: ["png"], role: "mask" }),
    sound: media("audio", { cardinality: "array", formats: ["mp3"] }),
  }, { maxImagePositions: 2, maxMediaPositions: 3, maxTotalBytes: 3000 }),
  genTool("clip_and_model", { clip: media("video", { formats: ["mp4", "mov"] }), model: media("model", { formats: ["glb", "fbx"] }) }),
];

/**
 * An uploader against a fake profile: tools/list answers the fixture plus EXTRA_TOOLS,
 * request_upload_url hands out tickets (`a<n>`, PUT to r2.test), finalize_upload answers
 * `https://cdn.test/<asset>`. `onPost(req)` may answer a whole POST itself (a Response);
 * `onCall(name, args)` may answer one message (a reply message object); `onPut(req)` may answer a PUT.
 */
async function setup({ key = "lmx_prod_k", cache = new Map(), onPost, onCall, onPut, clock = { t: 1_000_000 } } = {}) {
  let tickets = 0;
  const reply = (m) => {
    if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: [...structuredClone(FIXTURE.result.tools), ...EXTRA_TOOLS] } };
    const { name, arguments: args } = m.params;
    const custom = onCall?.(name, args, m);
    if (custom) return { jsonrpc: "2.0", id: m.id, ...custom };
    let data;
    if (name === "request_upload_url") {
      const n = ++tickets;
      data = { asset_id: `a${n}`, upload_url: `https://r2.test/put/a${n}?sig=x`, headers: { "Content-Type": args.mime, "Content-Length": String(args.size_hint), "x-amz-checksum": `c${n}` }, expires_at: "2026-10-12T00:15:00Z" };
    } else if (name === "finalize_upload") {
      data = { id: args.asset_id, url: `https://cdn.test/${args.asset_id}`, media_type: "image" };
    } else return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unexpected ${name}` } };
    return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
  };
  const f = mockFetch([
    ["POST", `/api/mcp/s/${PROFILE}`, async (req) => {
      const own = await onPost?.(req);
      if (own) return own;
      return jsonResponse(Array.isArray(req.json) ? req.json.map(reply) : reply(req.json));
    }],
    ["PUT", "https://r2.test/put/", (req) => onPut?.(req) ?? new Response(null, { status: 200 })],
  ]);
  restore = f.restore;
  const { ctx, rec } = fakeCtx({ config: { api_key: key, base_url: BASE, profile_url: PROFILE } });
  const now = () => clock.t;
  const lmx = createClient(ctx, { now });
  const catalog = createProfileCatalog(lmx, { now, log: ctx.log });
  const tools = (await catalog.get()).tools;
  f.calls.length = 0;
  const uploader = createUploader(ctx, lmx, createOutputs(ctx, lmx), { now, cache });
  const work = ctx.paths.workspaceWorkdir("ws");
  const art = ctx.paths.workspaceArtifacts("ws");
  /** A file in the workdir (or artifacts/…): string content, or a size for a sparse file. */
  const write = (rel, content) => {
    const m = /^artifacts\/(.*)$/.exec(rel);
    const abs = m ? path.join(art, m[1]) : path.join(work, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof content === "number") {
      fs.writeFileSync(abs, "");
      fs.truncateSync(abs, content);
    } else fs.writeFileSync(abs, content ?? `bytes of ${rel}`);
    return rel;
  };
  const upload = (tool, args, opts) => uploader.uploadFiles(CALL, tools.get(tool), args, opts);
  /** The tools/call messages sent, flattened over batches. */
  const sent = () => f.calls.filter((c) => c.method === "POST").flatMap((c) => (Array.isArray(c.json) ? c.json : [c.json])).map((m) => m.params);
  return { upload, f, rec, write, sent, clock, ctx, tools };
}

test("upload: a single and a mask argument are uploaded and swapped for their finalized URLs", async () => {
  const s = await setup();
  s.write("src.png", "source bytes");
  s.write("artifacts/t0/mask.png", "mask bytes!");
  const r = await s.upload("masked_edit", { text: "fix it", source: "src.png", edit_mask: "artifacts/t0/mask.png" });
  assert.deepEqual(r.arguments, { text: "fix it", source: "https://cdn.test/a1", edit_mask: "https://cdn.test/a2" });
  assert.deepEqual(r.references, ["src.png", "artifacts/t0/mask.png"]);
  const req = s.sent().filter((p) => p.name === "request_upload_url").map((p) => p.arguments);
  // exact size, family MIME, and nothing the upload tools reject
  assert.deepEqual(req, [
    { filename: "src.png", mime: "image/png", media_type: "image", size_hint: 12 },
    { filename: "mask.png", mime: "image/png", media_type: "image", size_hint: 11 },
  ]);
  assert.deepEqual(s.sent().filter((p) => p.name === "finalize_upload").map((p) => p.arguments), [{ asset_id: "a1" }, { asset_id: "a2" }]);
  const posts = s.f.calls.filter((c) => c.method === "POST");
  assert.ok(posts.every((c) => c.url === `${BASE}/api/mcp/s/${PROFILE}` && c.headers.authorization === "Bearer lmx_prod_k"));
  assert.ok(posts.every((c) => !JSON.stringify(c.json).includes("on_behalf_of") && !JSON.stringify(c.json).includes("api_key")));
});

test("upload: an array argument keeps its order; one path for a list slot is a list of one", async () => {
  const s = await setup();
  for (const n of ["a", "b", "c"]) s.write(`${n}.png`);
  const r = await s.upload("styled_portrait", { style: "photo", references: ["c.png", "a.png", "b.png"] });
  assert.deepEqual(r.arguments.references, ["https://cdn.test/a1", "https://cdn.test/a2", "https://cdn.test/a3"]);
  assert.deepEqual(s.sent().filter((p) => p.name === "request_upload_url").map((p) => p.arguments.filename), ["c.png", "a.png", "b.png"]);
  assert.equal(r.arguments.style, "photo");
  const one = await s.upload("styled_portrait", { references: "a.png" });
  assert.ok(Array.isArray(one.arguments.references) && one.arguments.references.length === 1);
});

test("upload: wrong format, oversize, too many items and a list for a single slot are refused before any HTTP", async () => {
  const s = await setup();
  s.write("src.png");
  s.write("mask.jpg");
  s.write("big.png", 21 * MIB);
  for (const n of [1, 2, 3, 4, 5]) s.write(`r${n}.png`);
  const refuse = async (tool, args, re) => {
    await assert.rejects(s.upload(tool, args), (e) => {
      assert.match(e.message, re);
      assert.match(e.message, /nothing was charged/);
      assert.equal(e.charged, false);
      return true;
    });
  };
  await refuse("masked_edit", { source: "src.png", edit_mask: "mask.jpg" }, /masked_edit\.edit_mask: mask\.jpg is \.jpg; this argument accepts png/);
  await refuse("styled_portrait", { references: ["big.png"] }, /styled_portrait\.references: big\.png is 21\.0 MiB; this argument takes up to 20\.0 MiB per file/);
  await refuse("styled_portrait", { references: ["r1.png", "r2.png", "r3.png", "r4.png", "r5.png"] }, /takes at most 4 files, got 5/);
  await refuse("masked_edit", { source: ["src.png", "src.png"] }, /masked_edit\.source takes one file path, not a list of 2/);
  await refuse("masked_edit", { source: "missing.png" }, /file not found: missing\.png/);
  await refuse("masked_edit", { source: "http://example.org/a.png" }, /neither a workspace path nor a finalized LoreMax https URL/);
  await refuse("masked_edit", { source: 42 }, /takes workspace paths/);
  assert.equal(s.f.calls.length, 0);
});

test("upload: the 50 MiB LoreMax cap applies even when the slot sets no size", async () => {
  const s = await setup();
  s.write("huge.png", 51 * MIB);
  await assert.rejects(s.upload("many_images", { images: ["huge.png"] }), /huge\.png is 51\.0 MiB; this argument takes up to 50\.0 MiB per file/);
  assert.equal(s.f.calls.length, 0);
});

test("upload: x-loremax-limits (image positions without masks, all positions, unique bytes) are checked before any HTTP", async () => {
  const s = await setup();
  s.write("a.png", "x".repeat(1000));
  s.write("b.png", "y".repeat(1000));
  s.write("copy-of-a.png", "x".repeat(1000));
  s.write("big1.png", "q".repeat(1600));
  s.write("big2.png", "w".repeat(1600));
  s.write("m.png", "m");
  s.write("s.mp3", "s");
  // a repeated file is a position each time
  await assert.rejects(s.upload("tight", { images: ["a.png", "a.png", "a.png"] }), /tight: 3 images \(masks aside\); this tool takes at most 2 per call — nothing was charged/);
  // two images, a mask and a sound: four positions, the mask being no image position
  await assert.rejects(s.upload("tight", { images: ["a.png", "b.png"], mask: "m.png", sound: ["s.mp3"] }), /tight: 4 files; this tool takes at most 3 per call/);
  await assert.rejects(s.upload("tight", { images: ["big1.png", "big2.png"] }), /tight: the files add up to 3200 bytes; this tool takes at most 3000 bytes per call/);
  assert.equal(s.f.calls.length, 0);
  // two images and a mask fit; the same bytes under two names count once (2001 unique bytes of 3000)
  const ok = await s.upload("tight", { images: ["a.png", "copy-of-a.png"], mask: "m.png" });
  assert.deepEqual(ok.arguments, { images: ["https://cdn.test/a1", "https://cdn.test/a1"], mask: "https://cdn.test/a2" });
});

test("upload: a path that leaves the workspace is refused", async () => {
  const s = await setup();
  await assert.rejects(s.upload("masked_edit", { source: "../../../../etc/hosts" }), /path is outside your workspace: \.\.\/\.\.\/\.\.\/\.\.\/etc\/hosts — nothing was charged/);
  assert.equal(s.f.calls.length, 0);
});

test("upload: MIME by media type — an audio .mp4 is audio/mp4, a video .mov and a .glb get theirs", async () => {
  const s = await setup();
  s.write("line.mp4", "aac in mp4");
  s.write("clip.mov", "qt");
  s.write("hero.glb", "gltf");
  await s.upload("voice_over", { voice: "line.mp4" });
  await s.upload("clip_and_model", { clip: "clip.mov", model: "hero.glb" });
  assert.deepEqual(s.sent().filter((p) => p.name === "request_upload_url").map((p) => [p.arguments.mime, p.arguments.media_type]), [
    ["audio/mp4", "audio"],
    ["video/quicktime", "video"],
    ["model/gltf-binary", "model"],
  ]);
});

test("upload: 60 files go as request batches of ≤ 50 and finalize chunks of ≤ 5", async () => {
  const s = await setup();
  const names = Array.from({ length: 60 }, (_, i) => s.write(`f${i}.png`, `file ${i}`));
  const r = await s.upload("many_images", { images: names });
  const posts = s.f.calls.filter((c) => c.method === "POST");
  const requests = posts.filter((c) => c.json[0]?.params?.name === "request_upload_url").map((c) => c.json.length);
  const finals = posts.filter((c) => c.json[0]?.params?.name === "finalize_upload").map((c) => c.json.length);
  assert.deepEqual(requests, [50, 10]);
  assert.deepEqual(finals, Array(12).fill(5));
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, 60);
  assert.deepEqual(r.arguments.images, names.map((_, i) => `https://cdn.test/a${i + 1}`));
});

test("upload: the PUT carries exactly the signed headers and the bytes, never the Bearer key", async () => {
  const s = await setup();
  s.write("src.png", "PNGDATA");
  await s.upload("masked_edit", { source: "src.png" });
  const put = s.f.calls.find((c) => c.method === "PUT");
  assert.equal(put.url, "https://r2.test/put/a1?sig=x");
  assert.deepEqual(put.headers, { "content-type": "image/png", "content-length": "7", "x-amz-checksum": "c1" });
  assert.equal(Buffer.from(put.body).toString(), "PNGDATA");
});

test("upload: a lost finalize chunk uploads only its own files again", async () => {
  let failed = false;
  const s = await setup({
    onPost: (req) => {
      const first = req.json?.[0]?.params;
      // the second finalize chunk (a6, a7) times out once
      if (!failed && first?.name === "finalize_upload" && first.arguments.asset_id === "a6") {
        failed = true;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
    },
  });
  const names = Array.from({ length: 7 }, (_, i) => s.write(`g${i}.png`, `g ${i}`));
  const r = await s.upload("many_images", { images: names });
  const req = s.sent().filter((p) => p.name === "request_upload_url").map((p) => p.arguments.filename);
  assert.deepEqual(req, [...names, "g5.png", "g6.png"]);
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, 9);
  assert.deepEqual(r.arguments.images.slice(5), ["https://cdn.test/a8", "https://cdn.test/a9"]);
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /finalize_upload lost .* uploading 2 file\(s\) again/.test(l.msg)));
});

test("upload: a finalize reply missing from its batch counts as lost; a refused finalize does not retry", async () => {
  let dropped = false;
  const s = await setup({
    onCall: (name, args) => {
      if (name === "finalize_upload" && args.asset_id === "a1" && !dropped) {
        dropped = true;
        return { id: null, result: null };
      }
      if (name === "finalize_upload" && args.asset_id === "a3")
        return { result: { content: [{ type: "text", text: JSON.stringify({ error: "not an image", errorCode: "MEDIA_INPUT_INVALID" }) }], isError: true } };
    },
  });
  s.write("one.png", "1");
  const r = await s.upload("masked_edit", { source: "one.png" });
  assert.equal(r.arguments.source, "https://cdn.test/a2");
  s.write("two.png", "2");
  await assert.rejects(s.upload("masked_edit", { source: "two.png" }), (e) => e.code === "MEDIA_INPUT_INVALID" && e.charged === false && /not an image — nothing was charged/.test(e.message));
  assert.equal(s.sent().filter((p) => p.name === "request_upload_url").length, 3);
});

test("upload: identical bytes within a call are uploaded once, and every position gets the URL", async () => {
  const s = await setup();
  s.write("a.png", "same");
  s.write("twin.png", "same");
  const r = await s.upload("styled_portrait", { references: ["a.png", "twin.png", "a.png"] });
  assert.deepEqual(r.arguments.references, ["https://cdn.test/a1", "https://cdn.test/a1", "https://cdn.test/a1"]);
  assert.deepEqual(r.references, ["a.png", "twin.png", "a.png"]);
  assert.equal(s.sent().filter((p) => p.name === "request_upload_url").length, 1);
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, 1);
});

test("upload: the cache skips a repeat upload for an hour; another key misses", async () => {
  const cache = new Map();
  const clock = { t: 1_000_000 };
  const s = await setup({ cache, clock });
  s.write("src.png", "cached bytes");
  const first = await s.upload("masked_edit", { source: "src.png" });
  s.f.calls.length = 0;
  const again = await s.upload("masked_edit", { source: "src.png" });
  assert.equal(again.arguments.source, first.arguments.source);
  assert.equal(s.f.calls.length, 0);
  // stale after an hour
  clock.t += 3_600_001;
  await s.upload("masked_edit", { source: "src.png" });
  assert.equal(s.sent().filter((p) => p.name === "request_upload_url").length, 1);
  // the key is part of the cache key: another organization's key uploads anew
  const other = await setup({ cache, clock, key: "lmx_prod_other" });
  other.write("src.png", "cached bytes");
  await other.upload("masked_edit", { source: "src.png" });
  assert.equal(other.sent().filter((p) => p.name === "request_upload_url").length, 1);
});

test("upload: a same-size edit between hashing and the PUT is refused and never cached", async () => {
  const cache = new Map();
  let s;
  s = await setup({
    cache,
    onCall: (name) => {
      // the file changes after it was hashed, before its bytes are read for the PUT
      if (name === "request_upload_url") s.write("src.png", "BBBB");
    },
  });
  s.write("src.png", "AAAA");
  await assert.rejects(s.upload("masked_edit", { source: "src.png" }), (e) => e.charged === false && /src\.png changed while it was being uploaded/.test(e.message));
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, 0);
  assert.equal(cache.size, 0);
});

test("upload: an https URL passes through unchanged and is no reference", async () => {
  const s = await setup();
  const r = await s.upload("masked_edit", { text: "t", source: "https://cdn.loremax.test/org/abc.png" });
  assert.deepEqual(r, { arguments: { text: "t", source: "https://cdn.loremax.test/org/abc.png" }, references: [] });
  assert.equal(s.f.calls.length, 0);
});

test("upload: no file arguments → arguments unchanged, no HTTP", async () => {
  const s = await setup();
  const r = await s.upload("write_text", { text: "hello" });
  assert.deepEqual(r, { arguments: { text: "hello" }, references: [] });
  assert.equal(s.f.calls.length, 0);
});

test("upload: a refused ticket aborts everything — nothing was charged, no generation call", async () => {
  const s = await setup({
    onCall: (name, args) => {
      if (name === "request_upload_url" && args.filename === "bad.png")
        return { result: { content: [{ type: "text", text: JSON.stringify({ error: "mime refused" }) }], isError: true } };
    },
  });
  s.write("good.png", "g");
  s.write("bad.png", "b");
  await assert.rejects(s.upload("styled_portrait", { references: ["good.png", "bad.png"] }), (e) => e.charged === false && /mime refused — nothing was charged/.test(e.message));
  assert.equal(s.sent().filter((p) => p.name === "finalize_upload").length, 0);
  assert.equal(s.f.calls.filter((c) => c.method === "PUT").length, 0);
});

test("upload: a refused PUT aborts before finalize — nothing was charged", async () => {
  const s = await setup({ onPut: () => new Response("expired", { status: 403 }) });
  s.write("src.png");
  await assert.rejects(s.upload("masked_edit", { source: "src.png" }), (e) => e.charged === false && /upload of src\.png failed \(HTTP 403\) — nothing was charged/.test(e.message));
  assert.ok(!s.sent().some((p) => p.name === "finalize_upload"));
});

test("upload: out of budget → a deadline error, nothing charged", async () => {
  const clock = { t: 1_000_000 };
  const s = await setup({ clock });
  s.write("src.png");
  await assert.rejects(s.upload("masked_edit", { source: "src.png" }, { deadline: clock.t - 1 }), (e) => e.deadline === true && e.charged === false && /out of time/.test(e.message));
});
