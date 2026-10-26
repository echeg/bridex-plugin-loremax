import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A zod stand-in: every builder and modifier returns a chainable no-op (the host validates, not the plugin). */
const chain = () => new Proxy(function () {}, { get: () => () => chain(), apply: () => chain() });
export const z = new Proxy({}, { get: () => () => chain() });

// each test file runs in its own process: its temp workspaces go when it exits
const tempDirs = [];
process.once("exit", () => tempDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
// job row ids are unique per process, like the host's: the plugin's once-per-row wake set is process-wide
let seq = 0;

/** A PluginContext double that records everything the plugin hands to the host. */
export function fakeCtx({ config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loremax-test-"));
  tempDirs.push(dir);
  const rec = {
    tools: new Map(),
    checks: [],
    stats: [],
    needsConfig: [],
    outOfFunds: [],
    annotate: [],
    mirror: [],
    usage: [],
    wakes: [],
    logs: [],
    shutdown: [],
  };
  const jobs = [];
  const log = (level) => (msg) => rec.logs.push({ level, msg: String(msg) });
  const ctx = {
    name: "loremax",
    config,
    z,
    log: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    paths: {
      workspaceArtifacts: (ws) => path.join(dir, ws, "artifacts"),
      workspaceWorkdir: (ws) => path.join(dir, ws, "work"),
    },
    registerTool: (t) => rec.tools.set(t.name, t),
    registerCheck: (fn) => rec.checks.push(fn),
    registerStat: (fn) => rec.stats.push(fn),
    needsConfig: (hint) => rec.needsConfig.push(hint),
    onShutdown: (fn) => rec.shutdown.push(fn),
    billing: { outOfFunds: (input) => rec.outOfFunds.push(input) },
    artifacts: {
      annotate: (workspace, rel, meta) => rec.annotate.push({ workspace, rel, meta }),
      mirror: (workspace, rels) => rec.mirror.push({ workspace, rels }),
    },
    usage: { record: (u) => rec.usage.push(u) },
    wakeAgent: (w) => rec.wakes.push(w),
    jobs: {
      track: (input) => {
        const id = `job-${++seq}`;
        // like the host: track() params are kept as result.params until the job settles
        jobs.push({ ...input, id, status: "running", result: input.params ? { params: input.params } : null, error: null, createdAt: new Date().toISOString(), label: input.label ?? "", model: input.model ?? "" });
        return id;
      },
      settle: (id, outcome) => {
        const j = jobs.find((x) => x.id === id);
        if (j) Object.assign(j, { status: outcome.status, result: outcome.result ?? null, error: outcome.error ?? null });
      },
      find: (externalId) => jobs.find((j) => j.externalId === externalId) ?? null,
      pending: () => jobs.filter((j) => j.status === "running"),
    },
  };
  return { ctx, rec, jobs, dir };
}

/**
 * Replace globalThis.fetch with a router: routes are [method, url-substring or RegExp, handler],
 * handler(req) → Response | plain object (sent as JSON 200). Every request is recorded with its
 * headers, body (string, parsed JSON when possible, or the FormData itself) and redirect mode.
 * A 3xx with Location behaves like Node's fetch: `redirect: "error"` throws its TypeError, the
 * default follows with the same headers (custom ones like X-API-Key included) — 307/308 keep the
 * method and body, the rest turn into a GET.
 */
export function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  const fake = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let body = init.body;
    let json;
    if (typeof body === "string") {
      try {
        json = JSON.parse(body);
      } catch {}
    }
    const req = { url: String(url), method, headers, body, json, redirect: init.redirect ?? "follow" };
    calls.push(req);
    const route = routes.find(([m, match]) => m === method && (match instanceof RegExp ? match.test(req.url) : req.url.includes(match)));
    if (!route) return new Response(`no mock for ${method} ${req.url}`, { status: 404 });
    const out = await route[2](req, calls);
    const res = out instanceof Response ? out : jsonResponse(out);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || req.redirect === "manual") return res;
    if (req.redirect === "error") throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    const keep = res.status === 307 || res.status === 308;
    return fake(new URL(location, req.url).href, { ...init, method: keep ? init.method : "GET", body: keep ? init.body : undefined });
  };
  globalThis.fetch = fake;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const jsonResponse = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** A JSON-RPC tools/call reply the way LoreMax's MCP endpoint shapes it: the tool's data as JSON text. */
export const mcpResult = (data, id = 1) =>
  jsonResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });

/** A failed LoreMax tool: still HTTP 200, `isError` set and `{"error": "…"}` as the text. */
export const mcpError = (error, id = 1) =>
  jsonResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true } });

/** Set env vars for one test; returns a restore function. */
export function withEnv(vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * The plugin's sleep seam on a fake clock. A plain sleep advances the clock and
 * resolves on the next turn. The budget race passes an abort signal: it waits
 * until the test calls expire() (the clock jumps by its length) or the plugin
 * aborts it because the submission answered first.
 */
export function fakeSleep(clock) {
  const races = [];
  const slept = [];
  const sleep = (ms, signal) => {
    if (!signal) {
      slept.push(ms);
      clock.t += ms;
      return new Promise((r) => setImmediate(r));
    }
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const entry = () => {
        if (!signal.aborted) clock.t += ms;
        resolve();
      };
      races.push(entry);
      signal.addEventListener("abort", () => {
        races.splice(races.indexOf(entry) >>> 0, 1);
        resolve();
      }, { once: true });
    });
  };
  /** The budget runs out: waits until a race is armed, then ends every racing sleep. */
  const expire = async () => {
    await eventually(() => races.length > 0);
    races.splice(0).forEach((f) => f());
  };
  return { sleep, expire, slept, races };
}

/** Resolves once fn() is truthy (polled every turn, up to ~2 s). */
export async function eventually(fn, what = "condition") {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Job rows that stand for generations, not submission placeholders. */
export const generationRows = (jobs) => jobs.filter((j) => !String(j.externalId).startsWith("submit:"));
