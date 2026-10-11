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
  assert.equal(createClient(fakeCtx({ config: { base_url: "http://localhost:8788/" } }).ctx).baseUrl(), "http://localhost:8788");
});

test("base_url rejects non-http schemes", () => {
  const c = createClient(fakeCtx({ config: { base_url: "ftp://loremax.ai" } }).ctx);
  assert.throws(() => c.baseUrl(), /LOREMAX_BASE_URL must be an http\(s\) URL/);
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
