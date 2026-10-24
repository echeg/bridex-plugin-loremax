import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createClient, createProfileCatalog, createProfileInstructions, cleanInstructions, PLUGIN_VERSION } from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));

/** LoreMax's standard raw-MCP lines, the way it appends them after the manager's description. */
const STANDARD = [
  "Each workflow tool call starts one paid generation; check the price first.",
  "Use tools/list for current schemas and pass schema_revision unchanged.",
  "Poll check_generation until the generation is final.",
  "Do not automatically resubmit a failed or pending generation.",
  "on_behalf_of is a display-only label.",
  "An api_key argument must belong to this profile's organization.",
  "Media arguments take finalized organization URLs.",
].join("\n");
const STUDIO = "Use styled_portrait for every character card.\nNever run masked_edit on faces.";

let restore = () => {};
afterEach(() => restore());

/**
 * Instructions on a fake clock. The profile answers initialize with `init(req)`: a string (the
 * instructions), a Response, or anything else as the whole result; tools/list with the fixture.
 */
function setup(init = () => `${STUDIO}\n${STANDARD}`) {
  const f = mockFetch([[
    "POST",
    `/api/mcp/s/${PROFILE}`,
    async (req) => {
      const head = { jsonrpc: "2.0", id: req.json.id };
      if (req.json.method === "tools/list") return jsonResponse({ ...head, result: structuredClone(FIXTURE.result) });
      const out = await init(req);
      if (out instanceof Response) return out;
      return jsonResponse(typeof out === "string" ? { ...head, result: { protocolVersion: "2025-06-18", instructions: out } } : { ...head, ...out });
    },
  ]]);
  restore = f.restore;
  const clock = { t: 1_000_000 };
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE } });
  const lmx = createClient(ctx, { now: () => clock.t });
  const instructions = createProfileInstructions(lmx, { now: () => clock.t, log: ctx.log });
  const inits = () => f.calls.filter((c) => c.json?.method === "initialize");
  return { instructions, lmx, ctx, rec, clock, f, inits };
}

test("instructions: one initialize on the profile path with Bearer, protocol 2025-06-18 and the plugin's clientInfo", async () => {
  const { instructions, inits } = setup();
  assert.equal(await instructions.get(), STUDIO);
  const [req] = inits();
  assert.equal(req.url, `${BASE}/api/mcp/s/${PROFILE}`);
  assert.equal(req.headers.authorization, "Bearer lmx_prod_k");
  assert.equal(req.json.params.protocolVersion, "2025-06-18");
  assert.deepEqual(req.json.params.clientInfo, { name: "bridex-plugin-loremax", version: PLUGIN_VERSION });
});

test("instructions: PLUGIN_VERSION follows package.json and plugin.yaml", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PLUGIN_VERSION, pkg.version);
  const manifest = fs.readFileSync(new URL("../plugin.yaml", import.meta.url), "utf8");
  assert.equal(manifest.match(/^version:\s*(\S+)\s*$/m)?.[1], PLUGIN_VERSION);
});

test("instructions: cached for the catalog TTL (10 min), then reread", async () => {
  const { instructions, clock, inits } = setup();
  await instructions.get();
  clock.t += 9 * 60_000;
  assert.equal(await instructions.get(), STUDIO);
  assert.equal(inits().length, 1);
  clock.t += 2 * 60_000;
  assert.equal(await instructions.get(), STUDIO);
  assert.equal(inits().length, 2);
});

test("instructions: concurrent callers share one initialize", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { instructions, inits } = setup(async () => {
    await gate;
    return STUDIO;
  });
  const all = Promise.all([instructions.get(), instructions.get(), instructions.get()]);
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await all, [STUDIO, STUDIO, STUDIO]);
  assert.equal(inits().length, 1);
});

test("instructions: standard lines dropped wherever they are, the studio's lines kept in order", () => {
  const raw = `  Studio rule one.\n${STANDARD.split("\n")[2]}\nStudio rule two.\n  ${STANDARD.split("\n")[0]}\n\nStudio rule three.\n${STANDARD}\n`;
  assert.equal(cleanInstructions(raw), "Studio rule one.\nStudio rule two.\n\nStudio rule three.");
  // a studio line that only mentions a prefix later on is the studio's
  assert.equal(cleanInstructions("Remember: Poll check_generation is done for you."), "Remember: Poll check_generation is done for you.");
});

test("instructions: only standard text, blank text or a non-string → null", async () => {
  assert.equal(cleanInstructions(STANDARD), null);
  assert.equal(cleanInstructions("  \n \n"), null);
  assert.equal(cleanInstructions(undefined), null);
  const { instructions, inits, clock } = setup(() => STANDARD);
  assert.equal(await instructions.get(), null);
  // an empty result is still a result: cached like any other
  clock.t += 60_000;
  assert.equal(await instructions.get(), null);
  assert.equal(inits().length, 1);
});

for (const [what, init] of [
  ["an HTTP 500", () => new Response("boom", { status: 500 })],
  ["a profile 404", () => new Response("not found", { status: 404 })],
  ["a JSON-RPC error", () => ({ error: { code: -32603, message: "internal" } })],
  ["a result without instructions", () => ({ result: { protocolVersion: "2025-06-18" } })],
  ["non-JSON", () => new Response("<html>", { status: 200 })],
  ["a dropped connection", () => {
    throw new TypeError("fetch failed");
  }],
]) {
  test(`instructions: ${what} → null for this call, not cached, retried on the next`, async () => {
    let fail = true;
    const { instructions, inits, rec } = setup((req) => (fail ? init(req) : STUDIO));
    assert.equal(await instructions.get(), null);
    assert.ok(rec.logs.some((l) => l.level === "warn" && /initialize/.test(l.msg)));
    fail = false;
    assert.equal(await instructions.get(), STUDIO);
    assert.equal(inits().length, 2);
  });
}

test("instructions: a caller out of time gets null while the shared read goes on and fills the cache", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { instructions, clock, inits } = setup(async () => {
    await gate;
    return STUDIO;
  });
  assert.equal(await instructions.get({ deadline: clock.t + 20 }), null);
  // a deadline already past sends nothing new
  assert.equal(await instructions.get({ deadline: clock.t }), null);
  release();
  assert.equal(await instructions.get(), STUDIO);
  assert.equal(inits().length, 1);
});

test("instructions: invalidate() forces a reread, and a read started before it does not fill the cache", async () => {
  let text = STUDIO;
  let gate = null;
  const { instructions, inits } = setup(async () => {
    const t = text;
    await gate;
    return t;
  });
  assert.equal(await instructions.get(), STUDIO);
  text = "Edited studio text.";
  instructions.invalidate();
  assert.equal(await instructions.get(), "Edited studio text.");
  assert.equal(inits().length, 2);

  // a slow read in flight, then an edit: later callers do not join or keep the old read
  let release;
  gate = new Promise((r) => (release = r));
  instructions.invalidate();
  const old = instructions.get();
  await new Promise((r) => setImmediate(r));
  text = "Newest text.";
  instructions.invalidate();
  const fresh = instructions.get();
  release();
  assert.equal(await old, "Edited studio text.");
  assert.equal(await fresh, "Newest text.");
  gate = null;
  assert.equal(await instructions.get(), "Newest text.");
  assert.equal(inits().length, 4);
});

test("instructions: the catalog load sends no initialize", async () => {
  const { lmx, inits, f } = setup();
  const catalog = createProfileCatalog(lmx);
  await catalog.get();
  await catalog.get({ force: true });
  assert.equal(f.calls.filter((c) => c.json?.method === "tools/list").length, 2);
  assert.equal(inits().length, 0);
});
