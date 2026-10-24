import fs from "node:fs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { createClient, createProfileManagementId, createProfileEditor } from "../index.mjs";
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

const SERVERS_RE = /\/api\/v2\/mcp-servers$/;
const ONE_RE = /\/api\/v2\/mcp-servers\/17(\?|$)/;
/** GET /api/v2/mcp-servers/17: tools out of position order, one without a manager description. */
const PROFILE_BODY = () => ({
  profile: {
    name: "Studio",
    description: "Studio art rules",
    is_active: true,
    tools: [
      { workflow_id: 12, tool_name: "styled_portrait", position: 1, tool_description: "Portraits in the studio style" },
      { workflow_id: 7, tool_name: "masked_edit", position: 0, tool_description: null },
    ],
  },
  workflows: [{ workflow_id: 7, compatible: true }, { workflow_id: 12, compatible: true }],
  preview: {},
});

/**
 * The profile's management endpoints: GET answers `get()` (re-read per request), PUT answers
 * `put(req)` (default: a preview's `{ workflows, preview }`, or the saved profile).
 */
function profileRoutes(get, put = (req) => (req.url.includes("preview=true") ? { workflows: get().workflows, preview: {} } : { profile: req.json })) {
  return [
    ["GET", ONE_RE, get],
    ["PUT", ONE_RE, put],
  ];
}

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

  restore();

  // through the registered tool as well: one lookup for both calls
  const g = mockFetch([[ "GET", SERVERS_RE, () => SERVERS], ...profileRoutes(() => PROFILE_BODY())]);
  restore = g.restore;
  const t = await tools(config({ allow_profile_edit: true }));
  const edit = t.get("loremax_profile_edit");
  await edit.handler({ instructions: "New rules" }, CALL);
  await edit.handler({ instructions: "Newer rules" }, CALL);
  assert.equal(g.calls.filter((c) => SERVERS_RE.test(c.url)).length, 1);
  assert.deepEqual(g.calls.filter((c) => c.method === "GET" && ONE_RE.test(c.url)).map((c) => c.url), [`${BASE}/api/v2/mcp-servers/17`, `${BASE}/api/v2/mcp-servers/17`]);
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

// ---------- preview and apply ----------

/** An editor over mocked LoreMax with the management id already known: every recorded call is the edit's own. */
function editor(routes, { onSaved } = {}) {
  const f = mockFetch(routes);
  restore = f.restore;
  const lmx = createClient(fakeCtx({ config: config({ allow_profile_edit: true }) }).ctx);
  const edit = createProfileEditor(lmx, { profileManagementId: async () => 17, onSaved });
  const puts = () => f.calls.filter((c) => c.method === "PUT");
  const saves = () => puts().filter((c) => !c.url.includes("preview=true"));
  return { f, edit, puts, saves };
}

test("profile edit: a preview PUTs ?preview=true with the strict body and saves nothing", async () => {
  let saved = 0;
  const { f, edit, puts, saves } = editor(profileRoutes(() => PROFILE_BODY()), { onSaved: () => saved++ });
  const r = await edit({ tools: [{ tool: "masked_edit", description: "Repaint the masked area only" }] });
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].headers["x-api-key"], "lmx_prod_k");
  assert.deepEqual(puts().map((c) => c.url), [`${BASE}/api/v2/mcp-servers/17?preview=true`]);
  assert.equal(puts()[0].headers["content-type"], "application/json");
  // full replacement in position order: no position key, bindings, names and is_active untouched
  assert.deepEqual(puts()[0].json, {
    name: "Studio",
    description: "Studio art rules",
    is_active: true,
    tools: [
      { workflow_id: 7, tool_name: "masked_edit", tool_description: "Repaint the masked area only" },
      { workflow_id: 12, tool_name: "styled_portrait", tool_description: "Portraits in the studio style" },
    ],
  });
  assert.deepEqual(r, {
    applied: false,
    changes: [{ field: "tool:masked_edit", before: "", after: "Repaint the masked area only" }],
    incompatible: [],
    hint: "nothing saved yet — show these changes, then call again with apply: true to save",
  });
  assert.equal(saves().length, 0);
  assert.equal(saved, 0);
});

test("profile edit: apply rereads the profile and keeps a text changed in LoreMax since the preview", async () => {
  let current = PROFILE_BODY();
  let saved = 0;
  const { f, edit, saves } = editor(profileRoutes(() => structuredClone(current)), { onSaved: () => saved++ });
  const ask = { instructions: "Use the studio palette", tools: [{ tool: "masked_edit", description: "Inpaint" }] };
  await edit(ask);
  // a manager edits another tool's description in LoreMax between the preview and the apply
  current.profile.tools[0].tool_description = "Edited by the manager";
  current.profile.description = "Use the studio palette";
  const r = await edit({ ...ask, apply: true });
  assert.equal(f.calls.filter((c) => c.method === "GET").length, 2);
  // the save goes right after the fresh read
  assert.deepEqual(f.calls.slice(-2).map((c) => c.method), ["GET", "PUT"]);
  assert.equal(saves().length, 1);
  assert.equal(saves()[0].url, `${BASE}/api/v2/mcp-servers/17`);
  assert.deepEqual(saves()[0].json.tools, [
    { workflow_id: 7, tool_name: "masked_edit", tool_description: "Inpaint" },
    { workflow_id: 12, tool_name: "styled_portrait", tool_description: "Edited by the manager" },
  ]);
  // the diff is against what LoreMax held at apply time: the description already matched
  assert.deepEqual(r, { applied: true, changes: [{ field: "tool:masked_edit", before: "", after: "Inpaint" }], hint: "saved: every client of the profile sees the new texts" });
  assert.equal(saved, 1);
});

test("profile edit: null and \"\" clear a text (sent as \"\")", async () => {
  const { edit, puts } = editor(profileRoutes(() => PROFILE_BODY()));
  for (const v of [null, ""]) {
    const r = await edit({ instructions: v, tools: [{ tool: "styled_portrait", description: v }] });
    assert.deepEqual(r.changes, [
      { field: "description", before: "Studio art rules", after: "" },
      { field: "tool:styled_portrait", before: "Portraits in the studio style", after: "" },
    ]);
    const body = puts().at(-1).json;
    assert.equal(body.description, "");
    assert.equal(body.tools[1].tool_description, "");
    // a tool not asked about keeps what LoreMax had, null included
    assert.equal(body.tools[0].tool_description, null);
  }
});

test("profile edit: refusals before any request — nothing requested, a text over 2000 chars, bad shapes", async () => {
  const { f, edit } = editor(profileRoutes(() => PROFILE_BODY()));
  const long = "x".repeat(2001);
  for (const [args, re] of [
    [{}, /nothing requested/],
    [{ apply: true }, /nothing requested/],
    [{ tools: [] }, /nothing requested/],
    [{ instructions: long }, /instructions is 2001 characters — LoreMax takes at most 2000/],
    [{ tools: [{ tool: "masked_edit", description: long }] }, /"masked_edit" is 2001 characters/],
    [{ instructions: 5 }, /instructions must be a string/],
    [{ tools: [{ description: "x" }] }, /current name in `tool`/],
    [{ tools: [{ tool: "masked_edit" }] }, /needs a description/],
    [{ tools: [{ tool: "a", description: "x" }, { tool: "a", description: "y" }] }, /listed twice/],
    [{ tools: "masked_edit" }, /tools must be a list/],
  ]) {
    await assert.rejects(edit(args), re, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(f.calls.length, 0);
  // exactly 2000 is fine
  assert.equal((await edit({ instructions: "y".repeat(2000) })).changes.length, 1);
});

test("profile edit: an unknown tool lists the bound ones and sends no PUT", async () => {
  const { edit, puts } = editor(profileRoutes(() => PROFILE_BODY()));
  await assert.rejects(edit({ tools: [{ tool: "nope", description: "x" }], apply: true }), /no tool "nope" is bound to this profile — tools: masked_edit, styled_portrait/);
  assert.equal(puts().length, 0);
});

test("profile edit: the same texts again → nothing to change, no PUT", async () => {
  const { edit, puts } = editor(profileRoutes(() => PROFILE_BODY()));
  const r = await edit({ instructions: "Studio art rules", tools: [{ tool: "masked_edit", description: null }], apply: true });
  assert.deepEqual(r, { applied: false, changes: [], hint: "nothing to change: the profile already has these texts" });
  assert.equal(puts().length, 0);
});

test("profile edit: an unchanged text holding [redacted] is refused by name, no PUT", async () => {
  const cases = [
    [(b) => (b.profile.tools[0].tool_description = "See https://cdn.test/a.png?[redacted]"), { instructions: "x" }, /tool:styled_portrait contains "\[redacted\]"/],
    [(b) => (b.profile.description = "Ref ?[redacted]"), { tools: [{ tool: "masked_edit", description: "x" }] }, /description contains/],
    [(b) => (b.profile.name = "Studio ?[redacted]"), { instructions: "x" }, /name contains/],
  ];
  for (const [mutate, args, re] of cases) {
    const body = PROFILE_BODY();
    mutate(body);
    const { edit, puts } = editor(profileRoutes(() => structuredClone(body)));
    for (const apply of [false, true]) {
      await assert.rejects(edit({ ...args, apply }), (e) => re.test(e.message) && /LoreMax → Organization → MCP/.test(e.message));
    }
    assert.equal(puts().length, 0);
    restore();
  }
  // rewriting the redacted text itself is fine: it is replaced, not sent back
  const body = PROFILE_BODY();
  body.profile.description = "Ref ?[redacted]";
  const { edit } = editor(profileRoutes(() => structuredClone(body)));
  assert.deepEqual((await edit({ instructions: "Clean" })).changes, [{ field: "description", before: "Ref ?[redacted]", after: "Clean" }]);
});

test("profile edit: incompatible workflows — the preview reports them, apply refuses without a PUT", async () => {
  const bad = { workflow_id: 12, compatible: false, reason: "workflow disabled" };
  const body = PROFILE_BODY();
  body.workflows = [body.workflows[0], bad];
  const { edit, puts, saves } = editor(profileRoutes(() => structuredClone(body)));
  const r = await edit({ instructions: "x" });
  assert.deepEqual(r.incompatible, [bad]);
  assert.match(r.hint, /would refuse this save/);
  assert.doesNotMatch(r.hint, /apply: true/);
  await assert.rejects(edit({ instructions: "x", apply: true }), /not saved — the profile binds incompatible workflows.*workflow disabled/);
  assert.equal(saves().length, 0);
  assert.equal(puts().length, 1);
});

test("profile edit: a 400 surfaces LoreMax's issues and incompatible workflows; a 404 names the causes", async () => {
  const refusal = { error: "Validation failed", issues: [{ path: ["tools", 0, "tool_description"], message: "too long" }], workflows: [{ workflow_id: 7, compatible: false }] };
  const { edit } = editor(profileRoutes(() => PROFILE_BODY(), () => jsonResponse(refusal, 400)));
  for (const apply of [false, true]) {
    await assert.rejects(edit({ instructions: "x", apply }), (e) =>
      /refused the profile \(400\)/.test(e.message) && /too long/.test(e.message) && /incompatible workflows: \[\{"workflow_id":7,"compatible":false\}\]/.test(e.message));
  }
  restore();

  const gone = editor(profileRoutes(() => jsonResponse({ error: "Not found" }, 404)));
  await assert.rejects(gone.edit({ instructions: "x" }), (e) => e.code === "PROFILE_NOT_FOUND" && /no profile 17/.test(e.message) && /another organization/.test(e.message));
  assert.equal(gone.puts().length, 0);
});

test("profile edit: a 400 without JSON, and LoreMax's error or message, still say what was refused", async () => {
  for (const [reply, re] of [
    [() => new Response("tool_description too long", { status: 400 }), /refused the profile \(400\): "tool_description too long"/],
    [() => jsonResponse({ error: "Validation failed" }, 400), /\(400\): "Validation failed"/],
    [() => jsonResponse({ message: "Bad profile" }, 400), /\(400\): "Bad profile"/],
  ]) {
    const { edit } = editor(profileRoutes(() => PROFILE_BODY(), reply));
    await assert.rejects(edit({ instructions: "x" }), re);
    restore();
  }
});

test("profile edit: a save with no reply may or may not be stored, a 2xx without JSON is saved — both reread the caches", async () => {
  for (const [reply, applied] of [
    [() => { throw new TypeError("fetch failed"); }, false],
    [() => new Response("<html>502 Bad Gateway</html>", { status: 502 }), false],
    [() => new Response(null, { status: 204 }), true],
  ]) {
    let saved = 0;
    const { edit, saves } = editor(profileRoutes(() => PROFILE_BODY(), (req) => (req.url.includes("preview=true") ? { workflows: [] } : reply())), { onSaved: () => saved++ });
    if (applied) assert.equal((await edit({ instructions: "x", apply: true })).applied, true);
    else await assert.rejects(edit({ instructions: "x", apply: true }), /the save got no reply .* may or may not have been stored; preview again/);
    assert.equal(saves().length, 1);
    assert.equal(saved, 1);
    restore();
  }
  // LoreMax's own 5xx is a definite failure: nothing to reread
  let saved = 0;
  const { edit } = editor(profileRoutes(() => PROFILE_BODY(), () => jsonResponse({ error: "Internal error" }, 500)), { onSaved: () => saved++ });
  await assert.rejects(edit({ instructions: "x", apply: true }), (e) => e.status === 500 && !/may or may not/.test(e.message));
  assert.equal(saved, 0);
});

test("profile edit: a profile LoreMax returns without its tools is refused, never saved with tools: []", async () => {
  for (const got of [{}, { profile: { name: "Studio", description: "d", is_active: true } }, { profile: { name: "Studio", tools: null } }]) {
    const { edit, puts } = editor(profileRoutes(() => got));
    for (const apply of [false, true]) await assert.rejects(edit({ instructions: "x", apply }), /has no readable profile/);
    assert.equal(puts().length, 0);
    restore();
  }
});

test("profile edit: is_active is sent as LoreMax has it, false included", async () => {
  const body = PROFILE_BODY();
  body.profile.is_active = false;
  const { edit, saves } = editor(profileRoutes(() => structuredClone(body)));
  await edit({ instructions: "x", apply: true });
  assert.equal(saves()[0].json.is_active, false);
});

test("profile edit: a preview reads incompatible workflows from LoreMax's preview, else from the profile read", async () => {
  const bad = { workflow_id: 12, compatible: false };
  const { edit } = editor(profileRoutes(() => PROFILE_BODY(), () => ({ workflows: [bad], preview: {} })));
  assert.deepEqual((await edit({ instructions: "x" })).incompatible, [bad]);
  restore();

  const body = PROFILE_BODY();
  body.workflows = [bad];
  const fallback = editor(profileRoutes(() => structuredClone(body), () => ({ preview: {} })));
  assert.deepEqual((await fallback.edit({ instructions: "x" })).incompatible, [bad]);
});

test("profile edit: a new text holding [redacted] is refused, no PUT", async () => {
  const body = PROFILE_BODY();
  body.profile.tools[0].tool_description = "See https://cdn.test/a.png?[redacted]";
  const { edit, puts } = editor(profileRoutes(() => structuredClone(body)));
  // the redacted text copied into the new one, and a fresh text that holds it
  for (const args of [
    { tools: [{ tool: "styled_portrait", description: "See https://cdn.test/a.png?[redacted] — portraits only" }] },
    { instructions: "Ref ?[redacted]" },
  ]) {
    for (const apply of [false, true]) {
      await assert.rejects(edit({ ...args, apply }), (e) => /the new (tool:styled_portrait|description) contains "\[redacted\]"/.test(e.message) && /LoreMax → Organization → MCP/.test(e.message));
    }
  }
  assert.equal(puts().length, 0);
});

test("profile edit: a tool name holding [redacted] is refused, no PUT", async () => {
  const body = PROFILE_BODY();
  body.profile.tools[0].tool_name = "portrait?[redacted]";
  const { edit, puts } = editor(profileRoutes(() => structuredClone(body)));
  await assert.rejects(edit({ instructions: "x" }), /tool name portrait\?\[redacted\] contains "\[redacted\]"/);
  assert.equal(puts().length, 0);
});

test("profile edit: a long preview is cut after the verdict, never before it", async () => {
  const body = PROFILE_BODY();
  body.profile.tools = Array.from({ length: 6 }, (_, i) => ({ workflow_id: 100 + i, tool_name: `tool_${i}`, position: i, tool_description: "o".repeat(1500) }));
  body.workflows = [{ workflow_id: 105, compatible: false }];
  const f = mockFetch([["GET", SERVERS_RE, () => SERVERS], ...profileRoutes(() => structuredClone(body))]);
  restore = f.restore;
  const t = await tools(config({ allow_profile_edit: true }));
  const args = { tools: body.profile.tools.map((x) => ({ tool: x.tool_name, description: "n".repeat(1500) })) };
  const out = (await t.get("loremax_profile_edit").handler(args, CALL)).content[0].text;
  assert.ok(out.endsWith("…(truncated)"));
  const head = out.slice(0, out.indexOf('\n "changes": ['));
  assert.match(head, /"incompatible": \[/);
  assert.match(head, /LoreMax would refuse this save/);
});

test("profile edit: out of time before a request → the deadline error, nothing sent", async () => {
  const { f, edit } = editor(profileRoutes(() => PROFILE_BODY()));
  await assert.rejects(edit({ instructions: "x", apply: true }, { deadline: Date.now() - 1 }), (e) => e.deadline === true);
  assert.equal(f.calls.length, 0);
});

const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-tools-list.json", import.meta.url), "utf8"));

test("profile edit: after a save the catalog and the instructions are reread; a preview leaves them cached", async () => {
  const f = mockFetch([
    ["GET", SERVERS_RE, () => SERVERS],
    ...profileRoutes(() => PROFILE_BODY()),
    ["POST", `/api/mcp/s/${PROFILE}`, (req) =>
      jsonResponse({ jsonrpc: "2.0", id: req.json.id, result: req.json.method === "initialize" ? { instructions: "Studio art rules" } : { tools: structuredClone(FIXTURE.result.tools) } })],
  ]);
  restore = f.restore;
  const t = await tools(config({ allow_profile_edit: true }));
  const list = async () => JSON.parse((await t.get("loremax_workflows").handler({}, CALL)).content[0].text);
  const count = (m) => f.calls.filter((c) => c.json?.method === m).length;
  const edit = async (args) => JSON.parse((await t.get("loremax_profile_edit").handler(args, CALL)).content[0].text);

  assert.equal((await list()).instructions, "Studio art rules");
  await list();
  assert.deepEqual([count("tools/list"), count("initialize")], [1, 1]);

  assert.equal((await edit({ instructions: "New rules" })).applied, false);
  await list();
  assert.deepEqual([count("tools/list"), count("initialize")], [1, 1]);

  assert.equal((await edit({ instructions: "New rules", apply: true })).applied, true);
  await list();
  assert.deepEqual([count("tools/list"), count("initialize")], [2, 2]);
});

test("profile edit: the tool's schema and description", async () => {
  restore = mockFetch([]).restore;
  const t = (await tools(config({ allow_profile_edit: true }))).get("loremax_profile_edit");
  assert.deepEqual(Object.keys(t.schema), ["instructions", "tools", "apply"]);
  assert.match(t.description, /EVERY client of the profile/);
  assert.match(t.description, /preview first/);
  assert.match(t.description, /apply: true/);
});
