import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUIDE } from "../guide.mjs";
import { guideKey, guideEntry, recommendedFrom } from "../index.mjs";
import { fakeCtx, mockFetch } from "./helpers.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// exactly what guideKey() writes: "id:007" would never be found
const KEY_RE = /^(id:(0|[1-9]\d*)|(?!id:)\S+)$/;

// --- the shipped guide ---

test("shipped guide: rules are non-empty strings", () => {
  assert.ok(Array.isArray(GUIDE.rules) && GUIDE.rules.length > 0);
  for (const r of GUIDE.rules) assert.ok(typeof r === "string" && r.trim(), `bad rule ${JSON.stringify(r)}`);
});

test("shipped guide: every key is a visual id or id:<n>, every entry has a use_for", () => {
  for (const [k, e] of Object.entries(GUIDE.workflows)) {
    assert.match(k, KEY_RE, `bad key ${k}`);
    assert.ok(typeof e?.use_for === "string" && e.use_for.trim(), `${k}: empty use_for`);
  }
});

test("shipped guide: every route has a task and picks only keys present in workflows", () => {
  assert.ok(Array.isArray(GUIDE.routes));
  for (const r of GUIDE.routes) {
    assert.ok(typeof r.task === "string" && r.task.trim(), `bad task ${JSON.stringify(r.task)}`);
    assert.ok(Array.isArray(r.pick) && r.pick.length > 0, `${r.task}: no picks`);
    for (const k of r.pick) assert.ok(Object.hasOwn(GUIDE.workflows, k), `${r.task}: pick ${k} has no entry in workflows`);
  }
});

const exportPath = [process.env.LOREMAX_CATALOG_EXPORT, path.join(ROOT, "docs/catalog/loremax-workflows.json")].find((p) => p && fs.existsSync(p));

test("shipped guide: every key exists in the catalog export", { skip: exportPath ? false : "no catalog export (LOREMAX_CATALOG_EXPORT or docs/catalog/loremax-workflows.json)" }, () => {
  const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const list = Array.isArray(data) ? data : data.workflows;
  assert.ok(Array.isArray(list), "the export holds no workflow list");
  const known = new Set();
  for (const w of list) {
    const visualId = w.visualId ?? w.visual_id;
    const workflowId = w.workflowId ?? w.id;
    for (const k of [guideKey({ visualId }), guideKey({ workflowId })]) if (k) known.add(k);
  }
  for (const k of Object.keys(GUIDE.workflows)) assert.ok(known.has(k), `guide key ${k} is not in the catalog export`);
});

// --- guideKey / guideEntry ---

test("guideKey: visual id, else id:<n>, else null", () => {
  assert.equal(guideKey({ visualId: "masked-edit", workflowId: 7 }), "masked-edit");
  assert.equal(guideKey({ visualId: "  ", workflowId: 7 }), "id:7");
  assert.equal(guideKey({ visualId: null, workflowId: 1 }), "id:1");
  assert.equal(guideKey({ workflowId: "12" }), "id:12");
  assert.equal(guideKey({ workflowId: "abc" }), null);
  assert.equal(guideKey({ workflowId: 1.5 }), null);
  assert.equal(guideKey({}), null);
  assert.equal(guideKey(), null);
});

const G = {
  rules: ["r"],
  workflows: {
    "masked-edit": { use_for: "inpaint a region", knobs: "mask", caveats: "none" },
    "styled-portrait": { use_for: "a stylised portrait" },
    "id:1": { use_for: "plain text-to-image" },
    "id:7": { use_for: "numeric entry for masked-edit" },
    "gone": { use_for: "not in any catalog" },
  },
  routes: [
    { task: "image edit / inpaint", pick: ["masked-edit"] },
    { task: "key art / illustration", pick: ["styled-portrait", "gone", "id:1"] },
    { task: "3D model", pick: ["gone"] },
  ],
};

test("guideEntry: by visual id, then id:<n>; the visual id wins", () => {
  assert.equal(guideEntry(G, { visualId: "masked-edit", workflowId: 7 }).use_for, "inpaint a region");
  assert.equal(guideEntry(G, { visualId: "unknown", workflowId: 7 }).use_for, "numeric entry for masked-edit");
  assert.equal(guideEntry(G, { visualId: null, workflowId: 1 }).use_for, "plain text-to-image");
  assert.equal(guideEntry(G, { visualId: "unknown", workflowId: 99 }), null);
  assert.equal(guideEntry(G, {}), null);
});

test("guideEntry: never finds inherited keys or a broken guide", () => {
  assert.equal(guideEntry(G, { visualId: "constructor" }), null);
  assert.equal(guideEntry(G, { visualId: "__proto__" }), null);
  assert.equal(guideEntry({}, { visualId: "masked-edit" }), null);
  assert.equal(guideEntry(null, { visualId: "masked-edit" }), null);
  assert.equal(guideEntry({ workflows: { x: "not an object" } }, { visualId: "x" }), null);
});

// --- recommendedFrom ---

const ITEMS = [
  { workflowId: 1, visualId: null, title: "Text to image", category: "image" },
  { workflowId: 7, visualId: "masked-edit", title: "Masked edit", category: "image" },
  { workflowId: 12, visualId: "styled-portrait", title: "Styled portrait", category: "portrait" },
];
const shape = (rec) => rec.map((r) => ({ task: r.task, picks: r.picks.map((p) => p.item.workflowId) }));

test("recommendedFrom: dead picks and dead routes dropped, pick order kept, entries attached", () => {
  const rec = recommendedFrom(G, ITEMS);
  assert.deepEqual(shape(rec), [
    { task: "image edit / inpaint", picks: [7] },
    { task: "key art / illustration", picks: [12, 1] },
  ]);
  assert.equal(rec[0].picks[0].item, ITEMS[1], "items come back as given");
  assert.equal(rec[0].picks[0].entry.use_for, "inpaint a region");
  assert.equal(rec[1].picks[1].entry.use_for, "plain text-to-image");
});

test("recommendedFrom: pick order follows the route, not the catalog", () => {
  const g = { workflows: G.workflows, routes: [{ task: "t", pick: ["id:1", "styled-portrait", "masked-edit"] }] };
  assert.deepEqual(shape(recommendedFrom(g, ITEMS)), [{ task: "t", picks: [1, 12, 7] }]);
});

test("recommendedFrom: an item picked under both of its keys counts once", () => {
  const g = { workflows: G.workflows, routes: [{ task: "t", pick: ["id:7", "masked-edit"] }] };
  assert.deepEqual(shape(recommendedFrom(g, ITEMS)), [{ task: "t", picks: [7] }]);
});

test("recommendedFrom: two profile tools bound to one workflow are both picked", () => {
  const twins = [{ name: "a", workflowId: 7, visualId: "masked-edit", title: "A" }, { name: "b", workflowId: 7, visualId: "masked-edit", title: "B" }];
  const rec = recommendedFrom(G, twins);
  assert.deepEqual(rec[0].picks.map((p) => p.item.name), ["a", "b"]);
});

test("recommendedFrom: a query matching the task keeps the whole route", () => {
  assert.deepEqual(shape(recommendedFrom(G, ITEMS, "  KEY ART ")), [{ task: "key art / illustration", picks: [12, 1] }]);
});

test("recommendedFrom: a query matching items keeps only those items", () => {
  assert.deepEqual(shape(recommendedFrom(G, ITEMS, "portrait")), [{ task: "key art / illustration", picks: [12] }]);
  assert.deepEqual(shape(recommendedFrom(G, ITEMS, "masked")), [{ task: "image edit / inpaint", picks: [7] }]);
  // by category: every image item in every route
  assert.deepEqual(shape(recommendedFrom(G, ITEMS, "image")), [
    { task: "image edit / inpaint", picks: [7] },
    { task: "key art / illustration", picks: [1] },
  ]);
  assert.deepEqual(recommendedFrom(G, ITEMS, "nothing-like-this"), []);
});

test("recommendedFrom: an empty or malformed guide gives []", () => {
  assert.deepEqual(recommendedFrom({ rules: [], workflows: {}, routes: [] }, ITEMS), []);
  assert.deepEqual(recommendedFrom({}, ITEMS), []);
  assert.deepEqual(recommendedFrom(null, ITEMS), []);
  assert.deepEqual(recommendedFrom({ routes: [null, { task: 1, pick: [] }, { task: "x", pick: "masked-edit" }] }, ITEMS), []);
  assert.deepEqual(recommendedFrom(G, []), []);
  assert.deepEqual(recommendedFrom(G, undefined), []);
});

test("recommendedFrom: the shipped guide over a catalog holding all its workflows recommends every route", () => {
  const items = Object.keys(GUIDE.workflows).map((k) => (/^id:\d+$/.test(k) ? { workflowId: Number(k.slice(3)) } : { visualId: k }));
  assert.deepEqual(recommendedFrom(GUIDE, items).map((r) => r.task), GUIDE.routes.map((r) => r.task));
  assert.deepEqual(recommendedFrom(GUIDE, []), []);
});

// --- plugin updates ---

test("an update loaded as index.mjs?v=<commit> serves that release's guide, not the first one's", async (t) => {
  // Bridex reloads an updated plugin in-process by importing its entry with ?v=<commit>
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loremax-reload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, "index.mjs"), path.join(dir, "index.mjs"));
  const release = (rules) => fs.writeFileSync(path.join(dir, "guide.mjs"), `export const GUIDE = ${JSON.stringify({ rules, workflows: {}, routes: [] })};\n`);
  const f = mockFetch([["GET", "/api/v1/workflows", () => ({ workflows: [] })]]);
  t.after(f.restore);
  const rulesOf = async (commit) => {
    const { default: activateRelease } = await import(`${pathToFileURL(path.join(dir, "index.mjs")).href}?v=${commit}`);
    const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: "https://lm.test" } });
    await activateRelease(ctx);
    return JSON.parse((await rec.tools.get("loremax_workflows").handler({}, {})).content[0].text).rules;
  };
  release(["release one"]);
  assert.deepEqual(await rulesOf("aaa111"), ["release one"]);
  release(["release two"]);
  assert.deepEqual(await rulesOf("bbb222"), ["release two"]);
});
