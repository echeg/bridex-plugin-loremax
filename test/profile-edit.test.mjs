import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { createClient, createProfileManagementId } from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const CALL = { agent: "a", workspace: "w", taskId: "t1" };
/** GET /api/v2/mcp-servers the way LoreMax answers it: this organization's profiles, ours among others. */
const SERVERS = {
  profiles: [
    { id: 3, public_id: "ZzZzZzZzZzZzZzZz", name: "Other" },
    { id: 17, public_id: PROFILE, name: "Studio" },
  ],
};

let restore = () => {};
afterEach(() => restore());

const config = (extra = {}) => ({ api_key: "lmx_prod_k", base_url: BASE, profile_url: PROFILE, ...extra });

async function tools(cfg) {
  const { ctx, rec } = fakeCtx({ config: cfg });
  await activate(ctx);
  return rec.tools;
}

test("profile edit: registered only in profile mode with allow_profile_edit", async () => {
  restore = mockFetch([]).restore;
  assert.equal((await tools({ api_key: "lmx_prod_k", base_url: BASE, allow_profile_edit: true })).has("loremax_profile_edit"), false);
  assert.equal((await tools(config())).has("loremax_profile_edit"), false);
  const on = await tools(config({ allow_profile_edit: true }));
  assert.deepEqual([...on.keys()].sort(), ["loremax_generate", "loremax_profile_edit", "loremax_result", "loremax_workflows"]);
  assert.match(on.get("loremax_profile_edit").description, /EVERY client of the profile/);
});

test("profile edit: allow_profile_edit is on only for a literal true", () => {
  const allowed = (v) => createClient(fakeCtx({ config: config({ allow_profile_edit: v }) }).ctx).allowProfileEdit();
  assert.equal(allowed(true), true);
  for (const v of ["true", "TRUE", 1, "1", "yes", "", null, undefined, false, {}]) assert.equal(allowed(v), false, JSON.stringify(v));
  assert.equal(createClient(fakeCtx({ config: config() }).ctx).allowProfileEdit(), false);
});

test("profile edit: an invalid profile_url with the flag on registers the tool and throws the config error before any HTTP", async () => {
  const f = mockFetch([]);
  restore = f.restore;
  const t = await tools(config({ profile_url: "https://evil.example.com/api/mcp/s/AbCdEfGh12345678", allow_profile_edit: true }));
  await assert.rejects(t.get("loremax_profile_edit").handler({}, CALL), (e) => e.config === true && /is on https:\/\/evil\.example\.com/.test(e.message));
  assert.equal(f.calls.length, 0);
});

test("profile edit: the management id is found by public_id and cached across calls", async () => {
  const f = mockFetch([["GET", `${BASE}/api/v2/mcp-servers`, () => SERVERS]]);
  restore = f.restore;
  const lmx = createClient(fakeCtx({ config: config() }).ctx);
  const profileManagementId = createProfileManagementId(lmx);
  assert.equal(await profileManagementId(), 17);
  assert.equal(await profileManagementId({ deadline: Date.now() + 10_000 }), 17);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers["x-api-key"], "lmx_prod_k");
  assert.equal(f.calls[0].redirect, "error");

  // through the registered tool as well: one lookup for both calls
  const t = await tools(config({ allow_profile_edit: true }));
  const edit = t.get("loremax_profile_edit");
  assert.equal(JSON.parse((await edit.handler({}, CALL)).content[0].text).profile_id, 17);
  await edit.handler({}, CALL);
  assert.equal(f.calls.length, 2);
});

test("profile edit: no matching profile → an error naming the publicId and the causes", async () => {
  for (const body of [{ profiles: [SERVERS.profiles[0]] }, { profiles: [] }, {}, { profiles: [{ id: "17", public_id: PROFILE }] }]) {
    const f = mockFetch([["GET", "/api/v2/mcp-servers", () => body]]);
    restore = f.restore;
    const profileManagementId = createProfileManagementId(createClient(fakeCtx({ config: config() }).ctx));
    await assert.rejects(profileManagementId(), (e) =>
      e.code === "PROFILE_NOT_FOUND" && e.message.includes(PROFILE) && /unknown, disabled or deleted/.test(e.message) && /another organization/.test(e.message));
    // a miss is not cached: the next call asks again
    await assert.rejects(profileManagementId());
    assert.equal(f.calls.length, 2);
    restore();
  }
});

test("profile edit: an HTTP error and a redirect from the lookup are refused like every other request", async () => {
  const f = mockFetch([
    ["GET", `${BASE}/api/v2/mcp-servers`, () => new Response("", { status: 302, headers: { location: "https://elsewhere.test/steal" } })],
    ["GET", "https://elsewhere.test/", () => SERVERS],
  ]);
  restore = f.restore;
  const lmx = createClient(fakeCtx({ config: config() }).ctx);
  await assert.rejects(createProfileManagementId(lmx)(), (e) => e.status === 0 && /redirected — refused/.test(e.message));
  assert.deepEqual(f.calls.map((c) => c.url), [`${BASE}/api/v2/mcp-servers`]);
  restore();

  const g = mockFetch([["GET", "/api/v2/mcp-servers", () => jsonResponse({ error: "Invalid API key" }, 401)]]);
  restore = g.restore;
  await assert.rejects(createProfileManagementId(lmx)(), (e) => e.status === 401 && /\/api\/v2\/mcp-servers/.test(e.message));
});
