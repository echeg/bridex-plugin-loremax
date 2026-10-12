import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import activate from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult } from "./helpers.mjs";

const BASE = "https://lm.test";
const PROFILE = "AbCdEfGh12345678";
const PROFILE_PATH = `/api/mcp/s/${PROFILE}`;
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));

let restore = () => {};
afterEach(() => restore());

/** The plugin activated on a fake clock in profile mode (or with `profile_url` given). */
async function setup(profile_url = PROFILE) {
  const clock = { t: 1_000_000 };
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE, profile_url } });
  await activate(ctx, { now: () => clock.t });
  return { rec, clock, check: rec.checks[0], stat: rec.stats[0] };
}

/** The profile answers tools/list with `tools()` and get_balance with `balance()` (a reply or a Response). */
function profileRoute({ tools = () => FIXTURE.result.tools, balance = () => ({ limit: 1000, used: 250, remaining: 750 }) } = {}) {
  return ["POST", PROFILE_PATH, (req) => {
    if (req.json.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: { tools: tools() } });
    assert.equal(req.json.params.name, "get_balance");
    const b = balance();
    return b instanceof Response ? b : mcpResult(b, req.json.id);
  }];
}

test("profile check: balance and tools/list on the profile path, reports the generation tools", async () => {
  const f = mockFetch([profileRoute()]);
  restore = f.restore;
  const s = await setup();
  assert.deepEqual(await s.check(), { ok: true, message: "profile reachable, 3 tools · 750 tk left" });
  assert.ok(f.calls.every((c) => c.url === `${BASE}${PROFILE_PATH}`), "never the organization-wide /api/mcp");
  assert.ok(f.calls.every((c) => c.headers.authorization === "Bearer lmx_prod_k"));
  const balance = f.calls.find((c) => c.json.params?.name === "get_balance");
  assert.deepEqual(balance.json.params.arguments, {});
  // a second check rereads the catalog instead of trusting the cache
  await s.check();
  assert.equal(f.calls.filter((c) => c.json.method === "tools/list").length, 2);
});

test("profile check: a balance that answers but a failing tools/list blames the catalog, not the key", async () => {
  const f = mockFetch([["POST", PROFILE_PATH, (req) =>
    req.json.method === "tools/list" ? new Response("boom", { status: 500 }) : mcpResult({ limit: 1000, used: 0, remaining: 750 }, req.json.id)]]);
  restore = f.restore;
  const s = await setup();
  const r = await s.check();
  assert.equal(r.ok, false);
  assert.match(r.message, /^key works, but the profile's tools\/list failed/);
});

test("profile check: one tool is singular; a profile without generation tools fails", async () => {
  let tools = FIXTURE.result.tools.filter((t) => t.name === "write_text" || !t.inputSchema?.properties?.schema_revision);
  const f = mockFetch([profileRoute({ tools: () => tools })]);
  restore = f.restore;
  const s = await setup();
  assert.deepEqual(await s.check(), { ok: true, message: "profile reachable, 1 tool · 750 tk left" });
  tools = FIXTURE.result.tools.filter((t) => !t.inputSchema?.properties?.schema_revision);
  const r = await s.check();
  assert.equal(r.ok, false);
  assert.match(r.message, /^profile reachable, 0 tools — add workflows to the profile/);
});

test("profile check: an empty balance fails but still says the profile is reachable", async () => {
  const f = mockFetch([profileRoute({ balance: () => ({ limit: 1000, used: 1000, remaining: 0 }) })]);
  restore = f.restore;
  const s = await setup();
  assert.deepEqual(await s.check(), { ok: false, message: "profile reachable, 3 tools, but the balance is empty — top up LoreMax" });
});

test("profile check: a 404 profile fails with the three-cause hint", async () => {
  const f = mockFetch([["POST", PROFILE_PATH, () => new Response("Not found", { status: 404 })]]);
  restore = f.restore;
  const s = await setup();
  const r = await s.check();
  assert.equal(r.ok, false);
  assert.match(r.message, /profile not found \(HTTP 404\)/);
  assert.match(r.message, /unknown, disabled in LoreMax, or LOREMAX_API_KEY belongs to another organization/);
  assert.match(r.message, /profile_url/);
  assert.equal(f.calls.length, 1, "tools/list is not tried after the 404");
});

test("profile check: a refused key is reported like in REST mode", async () => {
  const f = mockFetch([profileRoute({ balance: () => new Response("Invalid API key", { status: 401 }) })]);
  restore = f.restore;
  const s = await setup();
  assert.deepEqual(await s.check(), { ok: false, message: "LoreMax refused the key (401)" });
});

test("invalid profile_url: the check fails with the config error and nothing is fetched", async () => {
  const f = mockFetch([]);
  restore = f.restore;
  const s = await setup("https://elsewhere.test/api/mcp/s/AbCdEfGh12345678");
  const r = await s.check();
  assert.equal(r.ok, false);
  assert.match(r.message, /profile_url .* is on https:\/\/elsewhere\.test, not on the LoreMax base URL https:\/\/lm\.test/);
  assert.equal(r.message, s.rec.needsConfig[0]);
  assert.deepEqual(await s.stat(), []);
  assert.equal(f.calls.length, 0);
});

test("profile stat tile: balance read on the profile path, cached a minute, [] on a 404", async () => {
  let balance = () => ({ limit: 1000, used: 950, remaining: 50 });
  const f = mockFetch([profileRoute({ balance: () => balance() })]);
  restore = f.restore;
  const s = await setup();
  assert.deepEqual(await s.stat(), [{ label: "LoreMax balance", value: "50 tk", sub: "running out", balance: 0.05, low: true }]);
  assert.equal(f.calls[0].url, `${BASE}${PROFILE_PATH}`);
  await s.stat();
  assert.equal(f.calls.length, 1);

  s.clock.t += 61_000;
  balance = () => new Response("Not found", { status: 404 });
  assert.deepEqual(await s.stat(), []);
  assert.ok(s.rec.logs.some((l) => l.level === "warn" && /loremax balance: .*profile not found/.test(l.msg)));
});

test("REST mode: check and stat still read the balance on /api/mcp, with no tools/list", async () => {
  const f = mockFetch([["POST", "/api/mcp", (req) => mcpResult({ limit: 1000, used: 250, remaining: 750 }, req.json.id)]]);
  restore = f.restore;
  const s = await setup("");
  assert.deepEqual(await s.check(), { ok: true, message: "key works · 750 tk left" });
  assert.deepEqual(await s.stat(), [{ label: "LoreMax balance", value: "750 tk", sub: "balance", balance: 0.75, low: false }]);
  assert.ok(f.calls.every((c) => c.url === `${BASE}/api/mcp` && c.json.params.name === "get_balance"));
});
