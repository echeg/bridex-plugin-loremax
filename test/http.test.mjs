import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../index.mjs";
import { fakeCtx, mockFetch, jsonResponse, mcpResult, mcpError } from "./helpers.mjs";

const BASE = "https://lm.test";
const client = () => {
  const { ctx, rec } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  return { c: createClient(ctx), rec };
};

let restore = () => {};
afterEach(() => restore());

test("restJson sends X-API-Key against the base URL and parses JSON", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => ({ workflows: [] })]]);
  restore = f.restore;
  const { c } = client();
  assert.deepEqual(await c.restJson("/api/v1/workflows"), { workflows: [] });
  assert.equal(f.calls[0].url, `${BASE}/api/v1/workflows`);
  assert.equal(f.calls[0].headers["x-api-key"], "lmx_prod_k");
});

test("restJson: 402 → outOfFunds + throw", async () => {
  const f = mockFetch([["POST", "/api/v2/workflow/execute", () => jsonResponse({ error: "Insufficient tokens" }, 402)]]);
  restore = f.restore;
  const { c, rec } = client();
  await assert.rejects(c.restJson("/api/v2/workflow/execute", { method: "POST", body: "{}" }), /loremax 402 \/api\/v2\/workflow\/execute: .*Insufficient tokens/);
  assert.equal(rec.outOfFunds.length, 1);
  assert.equal(rec.outOfFunds[0].provider, "LoreMax");
  assert.match(rec.outOfFunds[0].detail, /Insufficient tokens/);
});

test("restJson: 'insufficient tokens' under another status still opens the billing card", async () => {
  const f = mockFetch([["POST", "/execute", () => jsonResponse({ error: "insufficient tokens for this workflow" }, 400)]]);
  restore = f.restore;
  const { c, rec } = client();
  await assert.rejects(c.restJson("/api/v2/workflow/execute", { method: "POST" }), /loremax 400/);
  assert.equal(rec.outOfFunds.length, 1);
});

test("restJson: other errors carry status, path and a trimmed body; no billing card", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => new Response("x".repeat(1000), { status: 401 })]]);
  restore = f.restore;
  const { c, rec } = client();
  const err = await c.restJson("/api/v1/workflows").catch((e) => e);
  assert.match(err.message, /^loremax 401 \/api\/v1\/workflows: x+$/);
  assert.ok(err.message.length < 450);
  assert.equal(err.status, 401);
  assert.equal(rec.outOfFunds.length, 0);
});

test("restJson: non-JSON body → clear error", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => new Response("<html>oops</html>", { status: 200 })]]);
  restore = f.restore;
  await assert.rejects(client().c.restJson("/api/v1/workflows"), /non-JSON from \/api\/v1\/workflows/);
});

test("restJson: 429 with Retry-After: 1 → one retry, then success", async () => {
  let n = 0;
  const f = mockFetch([["GET", "/api/v1/workflows", () => (++n === 1 ? jsonResponse({ error: "slow down" }, 429, { "retry-after": "1" }) : { workflows: [1] })]]);
  restore = f.restore;
  const started = Date.now();
  assert.deepEqual(await client().c.restJson("/api/v1/workflows"), { workflows: [1] });
  assert.equal(f.calls.length, 2);
  assert.ok(Date.now() - started >= 900, "waited for Retry-After");
});

test("restJson: 429 twice → throws loremax 429", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" })]]);
  restore = f.restore;
  await assert.rejects(client().c.restJson("/api/v1/workflows"), /^Error: loremax 429/);
  assert.equal(f.calls.length, 2);
});

test("mcpCall builds a stateless tools/call envelope with Bearer and returns the tool data", async () => {
  const f = mockFetch([["POST", "/api/mcp", (req) => mcpResult({ remaining: 42 }, req.json.id)]]);
  restore = f.restore;
  const { c } = client();
  assert.deepEqual(await c.mcpCall("get_balance", {}), { remaining: 42 });
  const req = f.calls[0];
  assert.equal(req.url, `${BASE}/api/mcp`);
  assert.equal(req.headers.authorization, "Bearer lmx_prod_k");
  assert.equal(req.headers["content-type"], "application/json");
  assert.match(req.headers.accept, /application\/json/);
  assert.equal(req.json.jsonrpc, "2.0");
  assert.equal(req.json.method, "tools/call");
  assert.deepEqual(req.json.params, { name: "get_balance", arguments: {} });
  assert.ok(req.json.id !== undefined);
});

test("mcpCall throws LoreMax's error text on an isError tool result", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => mcpError("Workflow not found: nope")]]);
  restore = f.restore;
  await assert.rejects(client().c.mcpCall("get_workflow_details", { visual_id: "nope" }), /loremax get_workflow_details: Workflow not found: nope/);
});

test("mcpCall: an insufficient-tokens tool error raises the out-of-funds card", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => mcpError("Insufficient tokens: need 40, have 3")]]);
  restore = f.restore;
  const { c, rec } = client();
  await assert.rejects(c.mcpCall("get_pricing", { workflowId: "w" }), /Insufficient tokens/);
  assert.equal(rec.outOfFunds.length, 1);
  assert.equal(rec.outOfFunds[0].provider, "LoreMax");
});

test("mcpCall: a non-JSON tool text is an error, not data", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "oops" }] } })]]);
  restore = f.restore;
  await assert.rejects(client().c.mcpCall("get_balance"), /loremax get_balance: oops/);
});

test("mcpCall throws on a JSON-RPC error object", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unknown tool: get_balanse" } })]]);
  restore = f.restore;
  await assert.rejects(client().c.mcpCall("get_balanse"), /loremax get_balanse: Unknown tool: get_balanse/);
});

test("mcpCall: 429 with Retry-After → one retry through the sleep seam, then the tool data; twice → throws", async () => {
  const slept = [];
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const c = createClient(ctx, { sleep: async (ms) => slept.push(ms) });
  let limited = 1;
  const f = mockFetch([["POST", "/api/mcp", (req) => (limited-- > 0 ? jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" }) : mcpResult({ remaining: 5 }, req.json.id))]]);
  restore = f.restore;
  assert.deepEqual(await c.mcpCall("get_balance"), { remaining: 5 });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(slept, [2_000]);
  limited = 2;
  const err = await c.mcpCall("get_balance").catch((e) => e);
  assert.match(err.message, /^loremax 429 \/api\/mcp get_balance: rate limited/);
  assert.equal(err.status, 429);
  assert.equal(f.calls.length, 4);
});

test("mcpCall: a Retry-After that does not fit before the deadline is not slept", async () => {
  const clock = { t: 0 };
  const slept = [];
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const c = createClient(ctx, { now: () => clock.t, sleep: async (ms) => slept.push(ms) });
  const f = mockFetch([["POST", "/api/mcp", () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" })]]);
  restore = f.restore;
  const err = await c.mcpCall("get_balance", {}, { deadline: 10_000 }).catch((e) => e);
  assert.equal(err.deadline, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(slept, []);
});

test("mcpCall: errorCode and details of an isError tool result ride on the thrown error", async () => {
  const details = { issues: [{ path: ["prompt"], message: "Required" }] };
  const f = mockFetch([["POST", "/api/mcp", () => jsonResponse({
    jsonrpc: "2.0", id: 1,
    result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Invalid workflow input", errorCode: "INVALID_WORKFLOW_INPUT", details }) }] },
  })]]);
  restore = f.restore;
  const err = await client().c.mcpCall("flux_portrait", {}).catch((e) => e);
  assert.match(err.message, /loremax flux_portrait: Invalid workflow input/);
  assert.equal(err.code, "INVALID_WORKFLOW_INPUT");
  assert.deepEqual(err.details, details);
  // a plain error has neither
  const f2 = mockFetch([["POST", "/api/mcp", () => mcpError("boom")]]);
  restore = () => (f2.restore(), f.restore());
  const plain = await client().c.mcpCall("x").catch((e) => e);
  assert.equal(plain.code, undefined);
  assert.equal(plain.details, undefined);
});

test("mcpCall: an INSUFFICIENT_TOKENS code opens the billing card even without the phrase", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => jsonResponse({
    jsonrpc: "2.0", id: 1,
    result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Balance too low", errorCode: "INSUFFICIENT_TOKENS", details: { requiredTokens: 40 } }) }] },
  })]]);
  restore = f.restore;
  const { c, rec } = client();
  const err = await c.mcpCall("flux_portrait", {}).catch((e) => e);
  assert.equal(err.code, "INSUFFICIENT_TOKENS");
  assert.deepEqual(err.details, { requiredTokens: 40 });
  assert.equal(rec.outOfFunds.length, 1);
});

test("mcpCall: HTTP 401 surfaces the status", async () => {
  const f = mockFetch([["POST", "/api/mcp", () => new Response("Unauthorized", { status: 401 })]]);
  restore = f.restore;
  const err = await client().c.mcpCall("get_balance").catch((e) => e);
  assert.match(err.message, /loremax 401 \/api\/mcp get_balance: Unauthorized/);
  assert.equal(err.status, 401);
});

test("restJson with a deadline: past it nothing is sent; a Retry-After that does not fit is not slept", async () => {
  const clock = { t: 1_000 };
  const slept = [];
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const c = createClient(ctx, { now: () => clock.t, sleep: async (ms) => slept.push(ms) });
  const f = mockFetch([["GET", "/api/v1/workflows", () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" })]]);
  restore = f.restore;
  const late = await c.restJson("/api/v1/workflows", {}, { deadline: 1_000 }).catch((e) => e);
  assert.equal(late.deadline, true);
  assert.equal(f.calls.length, 0);
  const tight = await c.restJson("/api/v1/workflows", {}, { deadline: 20_000 }).catch((e) => e);
  assert.equal(tight.deadline, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(slept, []);
  // with room left the wait goes through the sleep seam
  await assert.rejects(c.restJson("/api/v1/workflows", {}, { deadline: 60_000 }), /loremax 429/);
  assert.deepEqual(slept, [30_000]);
});

test("restJson: a request cut short by the deadline is a deadline error, not a transport failure", async () => {
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const c = createClient(ctx);
  const f = mockFetch([["GET", "/api/v1/workflows", (req) => new Promise(() => {})]]);
  restore = f.restore;
  // the mock ignores the signal: hand fetch a version that honors it
  const mocked = globalThis.fetch;
  globalThis.fetch = (url, init) => Promise.race([mocked(url, init), new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))]);
  try {
    const err = await c.restJson("/api/v1/workflows", {}, { deadline: Date.now() + 30 }).catch((e) => e);
    assert.equal(err.deadline, true);
    assert.match(err.message, /out of time/);
  } finally {
    globalThis.fetch = mocked;
  }
});

const PROFILE = "/api/mcp/s/AbCdEfGh12345678";
const toolText = (data, { id = 1, isError = false } = {}) =>
  ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) } });

test("rpc: a single message goes to the path with Bearer and returns the reply message", async () => {
  const f = mockFetch([["POST", PROFILE, (req) => ({ jsonrpc: "2.0", id: req.json.id, result: { tools: [] } })]]);
  restore = f.restore;
  const { c } = client();
  const msg = await c.rpc(PROFILE, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  assert.deepEqual(msg, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
  assert.equal(f.calls[0].url, `${BASE}${PROFILE}`);
  assert.equal(f.calls[0].headers.authorization, "Bearer lmx_prod_k");
  assert.equal(f.calls[0].json.method, "tools/list");
});

test("rpc: a batch goes as one POST and the replies come back keyed by id, whatever their order", async () => {
  const f = mockFetch([["POST", PROFILE, (req) => jsonResponse(req.json.map((m) => toolText({ asset_id: `a${m.id}` }, { id: m.id })).reverse())]]);
  restore = f.restore;
  const { c } = client();
  const batch = [1, 2, 3].map((n) => ({ jsonrpc: "2.0", id: c.nextId(), method: "tools/call", params: { name: "request_upload_url", arguments: { n } } }));
  const replies = await c.rpc(PROFILE, batch);
  assert.equal(f.calls.length, 1);
  assert.ok(Array.isArray(f.calls[0].json));
  assert.equal(replies.size, 3);
  for (const m of batch) assert.deepEqual(c.toolResult("request_upload_url", replies.get(m.id)), { asset_id: `a${m.id}` });
  // a message the server did not answer is a clear error, not undefined data
  assert.throws(() => c.toolResult("request_upload_url", replies.get(999)), /loremax request_upload_url: no reply/);
});

test("rpc: a batch rejected as a whole surfaces the server's error", async () => {
  const f = mockFetch([["POST", PROFILE, () => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } })]]);
  restore = f.restore;
  await assert.rejects(client().c.rpc(PROFILE, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), /Batch too large/);
});

test("rpc: 429 → one retry through the sleep seam; a Retry-After past the deadline is not slept", async () => {
  const clock = { t: 0 };
  const slept = [];
  const { ctx } = fakeCtx({ config: { api_key: "lmx_prod_k", base_url: BASE } });
  const c = createClient(ctx, { now: () => clock.t, sleep: async (ms) => slept.push(ms) });
  let limited = 1;
  const f = mockFetch([["POST", PROFILE, (req) => (limited-- > 0 ? jsonResponse({ error: "slow down" }, 429, { "retry-after": "3" }) : { jsonrpc: "2.0", id: req.json.id, result: {} })]]);
  restore = f.restore;
  await c.rpc(PROFILE, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { deadline: 60_000 });
  assert.deepEqual(slept, [3_000]);
  assert.equal(f.calls.length, 2);
  limited = 1;
  const err = await c.rpc(PROFILE, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { deadline: 2_000 }).catch((e) => e);
  assert.equal(err.deadline, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(slept, [3_000]);
  // past the deadline nothing is sent at all
  clock.t = 5_000;
  const late = await c.rpc(PROFILE, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { deadline: 5_000 }).catch((e) => e);
  assert.equal(late.deadline, true);
  assert.equal(f.calls.length, 3);
});

test("rpc: HTTP 404 on a profile path is PROFILE_NOT_FOUND with the three-cause hint, not retried", async () => {
  const f = mockFetch([["POST", PROFILE, () => new Response("Not found", { status: 404 })]]);
  restore = f.restore;
  const { c, rec } = client();
  const err = await c.toolCall(PROFILE, "get_balance").catch((e) => e);
  assert.equal(err.code, "PROFILE_NOT_FOUND");
  assert.equal(err.status, 404);
  assert.equal(err.retryable, false);
  assert.equal(err.charged, false);
  assert.match(err.message, /unknown/);
  assert.match(err.message, /disabled/);
  assert.match(err.message, /LOREMAX_API_KEY belongs to another organization/);
  assert.match(err.message, /profile_url/);
  assert.equal(f.calls.length, 1);
  assert.equal(rec.outOfFunds.length, 0);
  // a 404 on the organization endpoint stays a plain HTTP error
  const g = mockFetch([["POST", "/api/mcp", () => new Response("Not found", { status: 404 })]]);
  restore = () => (g.restore(), f.restore());
  const plain = await c.mcpCall("get_balance").catch((e) => e);
  assert.equal(plain.code, undefined);
  assert.match(plain.message, /^loremax 404 \/api\/mcp get_balance/);
});

test("rpc: a non-JSON body is a clear error", async () => {
  const f = mockFetch([["POST", PROFILE, () => new Response("<html>gateway</html>", { status: 200 })]]);
  restore = f.restore;
  await assert.rejects(client().c.toolCall(PROFILE, "get_balance"), new RegExp(`non-JSON from ${PROFILE} get_balance`));
});

test("toolCall: tools/call envelope on the profile path → the tool data", async () => {
  const f = mockFetch([["POST", PROFILE, (req) => jsonResponse(toolText({ generationId: "g1", status: "pending" }, { id: req.json.id }))]]);
  restore = f.restore;
  const { c } = client();
  assert.deepEqual(await c.toolCall(PROFILE, "flux_portrait", { prompt: "cat" }), { generationId: "g1", status: "pending" });
  assert.deepEqual(f.calls[0].json.params, { name: "flux_portrait", arguments: { prompt: "cat" } });
  assert.equal(f.calls[0].json.method, "tools/call");
});

test("toolCall: preflight codes are not charged; other codes and an uncoded isError leave charged unknown", async () => {
  const { c } = client();
  for (const code of ["SCHEMA_REVISION_MISMATCH", "INVALID_WORKFLOW_INPUT", "MEDIA_INPUT_INVALID", "WORKFLOW_UNAVAILABLE", "PROFILE_ORGANIZATION_MISMATCH"]) {
    const f = mockFetch([["POST", PROFILE, () => jsonResponse(toolText({ error: `${code} happened`, errorCode: code, details: { issues: [] } }, { isError: true }))]]);
    const err = await c.toolCall(PROFILE, "flux_portrait", {}).catch((e) => e);
    f.restore();
    assert.equal(err.code, code);
    assert.equal(err.charged, false, code);
    assert.deepEqual(err.details, { issues: [] });
    assert.match(err.message, new RegExp(`loremax flux_portrait: ${code} happened`));
  }
  for (const code of ["GENERATION_FAILED", "GENERATION_NOT_FOUND"]) {
    const f = mockFetch([["POST", PROFILE, () => jsonResponse(toolText({ error: "boom", errorCode: code, details: { generationId: "g9" } }, { isError: true }))]]);
    const err = await c.toolCall(PROFILE, "flux_portrait", {}).catch((e) => e);
    f.restore();
    assert.equal(err.code, code);
    assert.equal(err.charged, undefined, code);
    assert.deepEqual(err.details, { generationId: "g9" });
  }
  // uncoded: no code, no details
  const f = mockFetch([["POST", PROFILE, () => jsonResponse(toolText({ error: "something odd" }, { isError: true }))]]);
  restore = f.restore;
  const err = await c.toolCall(PROFILE, "flux_portrait", {}).catch((e) => e);
  assert.match(err.message, /loremax flux_portrait: something odd/);
  assert.equal(err.code, undefined);
  assert.equal(err.details, undefined);
  assert.equal(err.charged, undefined);
});

test("toolCall: JSON-RPC -32601 (never-bound tool) is TOOL_NOT_FOUND; another JSON-RPC error carries no code", async () => {
  const f = mockFetch([["POST", PROFILE, (req) => ({ jsonrpc: "2.0", id: req.json.id, error: { code: -32601, message: "Tool not found: nope" } })]]);
  restore = f.restore;
  const { c } = client();
  const err = await c.toolCall(PROFILE, "nope").catch((e) => e);
  assert.equal(err.code, "TOOL_NOT_FOUND");
  assert.equal(err.charged, false);
  assert.match(err.message, /loremax nope: Tool not found: nope/);
  const g = mockFetch([["POST", PROFILE, (req) => ({ jsonrpc: "2.0", id: req.json.id, error: { code: -32603, message: "Internal error" } })]]);
  restore = () => (g.restore(), f.restore());
  const other = await c.toolCall(PROFILE, "flux_portrait").catch((e) => e);
  assert.equal(other.code, undefined);
  assert.match(other.message, /Internal error/);
});

test("toolCall: an out-of-funds error opens the billing card exactly once", async () => {
  const f = mockFetch([["POST", PROFILE, () => jsonResponse(toolText({ error: "Insufficient tokens: need 40, have 3", errorCode: "INSUFFICIENT_TOKENS", details: { requiredTokens: 40 } }, { isError: true }))]]);
  restore = f.restore;
  const { c, rec } = client();
  const err = await c.toolCall(PROFILE, "flux_portrait", {}).catch((e) => e);
  assert.equal(err.code, "INSUFFICIENT_TOKENS");
  assert.equal(rec.outOfFunds.length, 1);
  assert.match(rec.outOfFunds[0].detail, /need 40/);
  // a 402 at the HTTP level: one card too
  const g = mockFetch([["POST", PROFILE, () => jsonResponse({ error: "Insufficient tokens" }, 402)]]);
  restore = () => (g.restore(), f.restore());
  await assert.rejects(c.toolCall(PROFILE, "flux_portrait", {}), /loremax 402/);
  assert.equal(rec.outOfFunds.length, 2);
});

// a redirect must not carry the key off the LoreMax host (nik-devs review, finding 3)
const redirectAway = (status = 302) => () => new Response("", { status, headers: { Location: "https://evil.test/steal" } });

test("restJson: a redirect is refused — the key never reaches the other host", async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = mockFetch([["GET", "/api/v1/workflows", redirectAway(status)], ["GET", "evil.test", () => ({ ok: true })]]);
    restore = f.restore;
    const err = await client().c.restJson("/api/v1/workflows").catch((e) => e);
    restore();
    assert.ok(err instanceof Error, `HTTP ${status} must throw`);
    assert.match(err.message, /^loremax \/api\/v1\/workflows: redirected — refused, the key must not leave lm\.test/);
    assert.equal(err.status, 0);
    assert.equal(f.calls.length, 1, `HTTP ${status}: one request, no follow`);
    assert.equal(f.calls[0].redirect, "error");
    assert.ok(!f.calls.some((c) => c.url.includes("evil.test")));
  }
});

test("mcpCall / rpc: a redirect is refused — the Bearer key never reaches the other host", async () => {
  const f = mockFetch([["POST", "/api/mcp", redirectAway(307)], ["POST", "evil.test", () => mcpResult({ remaining: 1 })]]);
  restore = f.restore;
  await assert.rejects(client().c.mcpCall("get_balance", {}), /loremax \/api\/mcp get_balance: redirected — refused, the key must not leave lm\.test/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].redirect, "error");
  assert.ok(!f.calls.some((c) => c.url.includes("evil.test")));
});

test("a redirect is a definite refusal, not a may-have-been-charged transport failure", async () => {
  const f = mockFetch([["POST", "/api/v2/workflow/execute", redirectAway()]]);
  restore = f.restore;
  const err = await client().c.restJson("/api/v2/workflow/execute", { method: "POST", body: "{}" }).catch((e) => e);
  assert.equal(err.status, 0);
  assert.notEqual(err.ambiguous, true);
});

test("a dropped connection is still the fetch TypeError, not a redirect", async () => {
  const f = mockFetch([["GET", "/api/v1/workflows", () => { throw new TypeError("fetch failed", { cause: new Error("other side closed") }); }]]);
  restore = f.restore;
  const err = await client().c.restJson("/api/v1/workflows").catch((e) => e);
  assert.ok(err instanceof TypeError);
  assert.doesNotMatch(err.message, /redirect/);
});
