import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { createClient } from "../index.mjs";
import { fakeCtx, mockFetch, withEnv } from "./helpers.mjs";

let restoreEnv = () => {};
let restoreFetch = () => {};
afterEach(() => {
  restoreEnv();
  restoreFetch();
});

test("api_key resolves ${ENV} references, the managed credential by default", () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: "lmx_prod_default", MY_LMX_KEY: "lmx_prod_custom" });
  assert.equal(createClient(fakeCtx().ctx).key(), "lmx_prod_default");
  assert.equal(createClient(fakeCtx({ config: { api_key: "${MY_LMX_KEY}" } }).ctx).key(), "lmx_prod_custom");
  assert.equal(createClient(fakeCtx({ config: { api_key: "lmx_prod_literal" } }).ctx).key(), "lmx_prod_literal");
  // an emptied form field falls back to the credential
  assert.equal(createClient(fakeCtx({ config: { api_key: "" } }).ctx).key(), "lmx_prod_default");
});

test("base_url defaults to https://loremax.ai", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: undefined });
  assert.equal(createClient(fakeCtx().ctx).baseUrl(), "https://loremax.ai");
});

test("base_url from the credential loses trailing slashes", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: "https://lm.example.com///" });
  assert.equal(createClient(fakeCtx().ctx).baseUrl(), "https://lm.example.com");
  assert.equal(createClient(fakeCtx({ config: { base_url: "https://localhost:8788/" } }).ctx).baseUrl(), "https://localhost:8788");
});

test("base_url is https only: http and other schemes are a config error naming the setting", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: undefined });
  const fromConfig = (base_url) => () => createClient(fakeCtx({ config: { base_url } }).ctx).baseUrl();
  for (const v of ["http://loremax.ai", "HTTP://localhost:8788", "ftp://loremax.ai", "loremax.ai"])
    assert.throws(fromConfig(v), (e) =>
      e.config === true && /LOREMAX_BASE_URL/.test(e.message) && /plugins\.loremax\.config\.base_url/.test(e.message) && /https/.test(e.message) && e.message.includes(v));
  assert.equal(fromConfig("HTTPS://lm.example.com")(), "HTTPS://lm.example.com");
});

test("LOREMAX_BASE_URL=http://… from the credential is refused the same way", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: "http://lm.example.com" });
  assert.throws(() => createClient(fakeCtx().ctx).baseUrl(), (e) => e.config === true && /LOREMAX_BASE_URL must be an https:\/\/ URL/.test(e.message));
});

test("usd_per_token: unset, empty or negative → 0", () => {
  assert.equal(createClient(fakeCtx().ctx).usdPerToken(), 0);
  assert.equal(createClient(fakeCtx({ config: { usd_per_token: null } }).ctx).usdPerToken(), 0);
  assert.equal(createClient(fakeCtx({ config: { usd_per_token: -1 } }).ctx).usdPerToken(), 0);
  assert.equal(createClient(fakeCtx({ config: { usd_per_token: 0.002 } }).ctx).usdPerToken(), 0.002);
});

test("missing key: needsConfig once at activate, every call throws the Settings hint before any HTTP", async () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: undefined });
  const f = mockFetch([]);
  restoreFetch = f.restore;
  const { ctx, rec } = fakeCtx();
  await activate(ctx);
  assert.equal(rec.needsConfig.length, 1);
  assert.match(rec.needsConfig[0], /LOREMAX_API_KEY/);

  const c = createClient(ctx);
  assert.equal(c.hasKey(), false);
  await assert.rejects(c.restJson("/api/v1/workflows"), /LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax/);
  await assert.rejects(c.mcpCall("get_balance"), /LOREMAX_API_KEY is not set/);
  assert.equal(f.calls.length, 0);
});

test("key present: activate does not ask for config", async () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: "lmx_prod_x" });
  const { ctx, rec } = fakeCtx();
  await activate(ctx);
  assert.deepEqual(rec.needsConfig, []);
});

test("http:// base_url: needsConfig once at activate (REST, or a full profile_url that reads it)", async () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: "lmx_prod_x", LOREMAX_BASE_URL: undefined });
  for (const profile_url of [undefined, "https://lm.example.com/api/mcp/s/AbCdEfGh12345678"]) {
    const { ctx, rec } = fakeCtx({ config: { base_url: "http://lm.example.com", ...(profile_url ? { profile_url } : {}) } });
    await activate(ctx);
    assert.equal(rec.needsConfig.length, 1, `profile_url ${profile_url}`);
    assert.match(rec.needsConfig[0], /LOREMAX_BASE_URL must be an https:\/\/ URL/);
  }
});

const PID = "AbCdEfGh12345678";

test("profile_url: empty → REST mode, bare publicId and full profile URL → the profile path", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: undefined, MY_PROFILE: PID });
  const path = (config) => createClient(fakeCtx({ config }).ctx).profilePath();
  assert.equal(path({}), null);
  assert.equal(path({ profile_url: "" }), null);
  assert.equal(path({ profile_url: "   " }), null);
  assert.equal(path({ profile_url: PID }), `/api/mcp/s/${PID}`);
  assert.equal(path({ profile_url: ` ${PID} ` }), `/api/mcp/s/${PID}`);
  assert.equal(path({ profile_url: "${MY_PROFILE}" }), `/api/mcp/s/${PID}`);
  assert.equal(path({ profile_url: `https://loremax.ai/api/mcp/s/${PID}` }), `/api/mcp/s/${PID}`);
  assert.equal(path({ profile_url: `https://loremax.ai/api/mcp/s/${PID}/` }), `/api/mcp/s/${PID}`);
  assert.equal(path({ base_url: "https://localhost:8788/", profile_url: `https://localhost:8788/api/mcp/s/${PID}` }), `/api/mcp/s/${PID}`);
});

test("profile_url: foreign origin, bad path, non-http → a config error naming the value", () => {
  restoreEnv = withEnv({ LOREMAX_BASE_URL: undefined });
  const path = (config) => () => createClient(fakeCtx({ config }).ctx).profilePath();
  // the key must not go to another host: both origins are named
  assert.throws(path({ profile_url: `https://evil.example.com/api/mcp/s/${PID}` }), (e) =>
    e.config === true && /https:\/\/evil\.example\.com/.test(e.message) && /https:\/\/loremax\.ai/.test(e.message));
  assert.throws(path({ profile_url: `http://loremax.ai/api/mcp/s/${PID}` }), (e) =>
    e.config === true && /profile_url "http:\/\/loremax\.ai/.test(e.message) && /must be an https:\/\/ URL/.test(e.message));
  assert.throws(path({ profile_url: "https://loremax.ai/api/mcp" }), /is not a profile URL/);
  assert.throws(path({ profile_url: "https://loremax.ai/api/mcp/s/short" }), /is not a profile URL/);
  assert.throws(path({ profile_url: `https://loremax.ai/api/mcp/s/${PID}/extra` }), /is not a profile URL/);
  assert.throws(path({ profile_url: `https://loremax.ai/api/mcp/s/${PID}?x=1` }), /is not a profile URL/);
  assert.throws(path({ profile_url: `ftp://loremax.ai/api/mcp/s/${PID}` }), /must be an https:\/\/ URL/);
  assert.throws(path({ profile_url: "not a url" }), /neither a profile URL nor a publicId/);
  assert.throws(path({ profile_url: "AbCdEfGh1234567" }), (e) => e.config === true && /profile_url "AbCdEfGh1234567"/.test(e.message));
});

test("mode: decided once at activate and logged", async () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: "lmx_prod_x", LOREMAX_BASE_URL: undefined });
  const rest = fakeCtx();
  await activate(rest.ctx);
  assert.ok(rest.rec.logs.some((l) => /loremax mode: REST/.test(l.msg)));
  assert.match(rest.rec.tools.get("loremax_workflows").description, /ALWAYS read it before a paid loremax_generate/);

  const prof = fakeCtx({ config: { profile_url: PID } });
  await activate(prof.ctx);
  assert.ok(prof.rec.logs.some((l) => l.msg === `loremax mode: profile /api/mcp/s/${PID}`));
  assert.deepEqual(prof.rec.needsConfig, []);
  assert.deepEqual([...prof.rec.tools.keys()].sort(), ["loremax_generate", "loremax_result", "loremax_workflows"]);
  assert.match(prof.rec.tools.get("loremax_workflows").description, /curated/);
  assert.match(prof.rec.tools.get("loremax_generate").description, /workspace paths/);
});

test("invalid profile_url: needsConfig, profile tool set, no REST call from any tool — every one throws the config error", async () => {
  restoreEnv = withEnv({ LOREMAX_API_KEY: "lmx_prod_x", LOREMAX_BASE_URL: undefined });
  const f = mockFetch([]);
  restoreFetch = f.restore;
  const { ctx, rec } = fakeCtx({ config: { profile_url: "https://evil.example.com/api/mcp/s/AbCdEfGh12345678" } });
  await activate(ctx);
  assert.equal(rec.needsConfig.length, 1);
  assert.match(rec.needsConfig[0], /profile_url/);
  assert.ok(rec.logs.some((l) => /loremax mode: profile \(invalid profile_url/.test(l.msg)));
  // the profile-mode set, never the REST catalog
  assert.match(rec.tools.get("loremax_workflows").description, /curated/);
  const call = { agent: "a", workspace: "w", taskId: "t1" };
  const args = {
    loremax_workflows: [{}, { tool: "x" }],
    loremax_generate: [{ tool: "x", arguments: {} }, { workflow_id: "1", inputs: {} }],
    loremax_result: [{ generation_id: "42" }, { generation_id: "42", wait_s: 5 }],
  };
  for (const [name, list] of Object.entries(args))
    for (const a of list) await assert.rejects(rec.tools.get(name).handler(a, call), (e) => e.config === true && /is on https:\/\/evil\.example\.com/.test(e.message));
  assert.equal(f.calls.length, 0);
});
