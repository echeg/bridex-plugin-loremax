import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A zod stand-in: every builder and modifier returns a chainable no-op (the host validates, not the plugin). */
const chain = () => new Proxy(function () {}, { get: () => () => chain(), apply: () => chain() });
export const z = new Proxy({}, { get: () => () => chain() });

/** A PluginContext double that records everything the plugin hands to the host. */
export function fakeCtx({ config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loremax-test-"));
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
  let seq = 0;
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
        jobs.push({ ...input, id, status: "running", result: null, error: null, createdAt: new Date().toISOString(), label: input.label ?? "", model: input.model ?? "" });
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
 * headers and body (string, parsed JSON when possible, or the FormData itself).
 */
export function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let body = init.body;
    let json;
    if (typeof body === "string") {
      try {
        json = JSON.parse(body);
      } catch {}
    }
    const req = { url: String(url), method, headers, body, json };
    calls.push(req);
    const route = routes.find(([m, match]) => m === method && (match instanceof RegExp ? match.test(req.url) : req.url.includes(match)));
    if (!route) return new Response(`no mock for ${method} ${req.url}`, { status: 404 });
    const out = await route[2](req, calls);
    return out instanceof Response ? out : jsonResponse(out);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const jsonResponse = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** A JSON-RPC tools/call reply the way LoreMax's MCP endpoint shapes it. */
export const mcpResult = (payload, id = 1) =>
  jsonResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });

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
