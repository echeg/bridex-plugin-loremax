import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * LoreMax plugin: image and video generation through the organization's
 * LoreMax workflows. Agents list workflows and read a workflow's input fields
 * and price (both free), run one with workspace files as references, and get
 * the outputs saved into the task's artifacts with provenance and token spend.
 * The key is the managed LOREMAX_API_KEY credential (Settings → Integrations),
 * read per call so it can be set without a restart.
 *
 *   plugins:
 *     loremax:
 *       config:
 *         api_key: ${LOREMAX_API_KEY}     # optional; this is the default
 *         base_url: ${LOREMAX_BASE_URL}   # optional; this is the default (the credential must be set: requires_env)
 *         default_wait_s: 45              # how long loremax_generate waits before handing back (10..50 s)
 *         usd_per_token: 0.001            # optional; tokens → USD for the spend charts
 */

const DEFAULT_BASE_URL = "https://loremax.ai";
/** LoreMax asks for Retry-After on 429; never sleep longer than this inside a tool call. */
const RETRY_AFTER_CAP_S = 30;
const RETRY_AFTER_DEFAULT_S = 5;
/** Tool replies go into the agent's context: keep a workflow's field dump bounded (as fal_schema does). */
const REPLY_CAP = 14_000;
/** Outputs bigger than this stay on LoreMax's CDN (same cap as fal). */
const DOWNLOAD_CAP = 512 * 1024 * 1024;
/** References are sent inline in the execute request (same cap as media's REF_CAP). */
const REF_CAP = 20 * 1024 * 1024;
const MAX_REFS = 20;
const POLL_MS = 3_000;
/**
 * Bridex agents' MCP client gives up on a tool call after 60 s, while the handler
 * goes on unseen: no call may run past 50 s from its start, and a finished
 * generation is saved inline only with this much of it left (downloads take time).
 */
const DEFAULT_WAIT_S = 45;
const MAX_WAIT_S = 50;
const FINISH_RESERVE_MS = 10_000;
/** The reboot-proof watcher's pass over pending jobs, and when it gives a generation up. */
const WATCH_MS = 15_000;
const GIVE_UP_MS = 6 * 3_600_000;
/** The dashboard polls stat tiles; LoreMax's balance is read at most once a minute. */
const BALANCE_TTL_MS = 60_000;
const KEY_HINT = "LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax (or plugins.loremax.config.api_key)";

const EXT_BY_MIME = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT.jpeg = "image/jpeg";

const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
/** A timer that an aborted signal ends early (and clears, so a lost race leaves no timer behind). */
const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** wait_s from a tool call → seconds in lo..MAX_WAIT_S (the test zod is a no-op: bounds live here). */
function waitSeconds(v, lo, fallback) {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), MAX_WAIT_S) : fallback;
}

/** Out of the tool call's time budget: the caller hands back what it has instead of failing. */
const deadlineError = (p) => Object.assign(new Error(`loremax ${p}: out of time for this tool call`), { deadline: true });

/** Retry-After in seconds (the HTTP-date form is not used by LoreMax) → ms, capped. */
function retryAfterMs(header) {
  // a missing header is null and Number(null) is 0: that would retry at once
  const s = header == null || header === "" ? NaN : Number(header);
  return Math.min(Number.isFinite(s) && s >= 0 ? s : RETRY_AFTER_DEFAULT_S, RETRY_AFTER_CAP_S) * 1000;
}

/** An Error carrying the HTTP status and body, so callers can tell a refused key from a dead generation. */
function httpError(message, status, body) {
  return Object.assign(new Error(message), { status, body });
}

/**
 * Config + the two LoreMax transports: REST (/api/v1, /api/v2 with X-API-Key)
 * and the stateless MCP endpoint (/api/mcp, Bearer) for what REST lacks —
 * workflow details, pricing, balance.
 */
export function createClient(ctx, { now = Date.now, sleep = realSleep } = {}) {
  const cfg = {
    api_key: "${LOREMAX_API_KEY}",
    base_url: "${LOREMAX_BASE_URL}",
    default_wait_s: DEFAULT_WAIT_S,
    usd_per_token: 0,
    ...(ctx.config ?? {}),
  };
  // an emptied form field arrives as "" — fall back to the managed credential, not to nothing
  const rawKey = () => resolveRef(cfg.api_key || "${LOREMAX_API_KEY}").trim();
  const key = () => {
    const k = rawKey();
    if (!k) throw new Error(KEY_HINT);
    return k;
  };
  const baseUrl = () => {
    const raw = resolveRef(cfg.base_url || "${LOREMAX_BASE_URL}").trim().replace(/\/+$/, "");
    if (!raw) return DEFAULT_BASE_URL;
    if (!/^https?:\/\/[^/]/i.test(raw)) throw new Error(`LOREMAX_BASE_URL must be an http(s) URL, got "${raw}"`);
    return raw;
  };
  const usdPerToken = () => {
    const v = Number(cfg.usd_per_token ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  // the host leaves config validation to the plugin: an emptied or bogus value means the default, not "no wait"
  const defaultWaitS = () => {
    const v = Number(cfg.default_wait_s);
    return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 10), MAX_WAIT_S) : DEFAULT_WAIT_S;
  };

  // an empty balance: one needs-a-person card in the inbox, not a silent failed run
  // (ctx.billing exists on newer Bridex cores; older ones just skip it)
  const outOfFunds = (detail) =>
    ctx.billing?.outOfFunds?.({ provider: "LoreMax", what: "image and video generation (loremax plugin)", detail: String(detail).slice(0, 400) });

  /** `deadline` (epoch ms, optional) ends the request and any Retry-After wait by then. */
  async function restJson(p, init = {}, { timeoutMs = 60_000, deadline } = {}) {
    const url = `${baseUrl()}${p}`;
    for (let attempt = 0; ; attempt++) {
      const left = deadline == null ? Infinity : deadline - now();
      if (left <= 0) throw deadlineError(p);
      const ms = Math.min(timeoutMs, left);
      let res;
      let body;
      try {
        res = await fetch(url, {
          ...init,
          headers: { "X-API-Key": key(), ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(ms),
        });
        body = await res.text();
      } catch (e) {
        // cut short by the deadline, not by the request's own timeout
        if (ms < timeoutMs && e?.name === "TimeoutError") throw deadlineError(p);
        throw e;
      }
      if (res.status === 429) {
        if (attempt === 0) {
          const wait = retryAfterMs(res.headers.get("retry-after"));
          // a wait that does not fit before the deadline is not slept
          if (deadline != null && now() + wait > deadline) throw deadlineError(p);
          await sleep(wait);
          continue;
        }
        throw httpError(`loremax 429 ${p}: rate limited (LoreMax allows 60/min, 1000/h) — ${body.slice(0, 200)}`, 429, body);
      }
      if (!res.ok) {
        if (res.status === 402 || /insufficient tokens/i.test(body)) outOfFunds(body);
        throw httpError(`loremax ${res.status} ${p}: ${body.slice(0, 400)}`, res.status, body);
      }
      try {
        return JSON.parse(body);
      } catch {
        throw httpError(`loremax returned non-JSON from ${p}: ${body.slice(0, 200)}`, res.status, body);
      }
    }
  }

  let rpcId = 0;
  /**
   * One stateless tools/call (no initialize needed) → the tool's data. LoreMax
   * puts the data itself as JSON in the text content; a failed tool sets
   * `isError` with `{"error": "…"}` there.
   */
  async function mcpCall(tool, args = {}, timeoutMs = 60_000) {
    const res = await fetch(`${baseUrl()}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key()}`,
        "Content-Type": "application/json",
        // Streamable HTTP clients announce both; LoreMax answers with plain JSON
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (!res.ok) {
      if (res.status === 402 || /insufficient tokens/i.test(body)) outOfFunds(body);
      throw httpError(`loremax ${res.status} /api/mcp ${tool}: ${body.slice(0, 400)}`, res.status, body);
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      throw httpError(`loremax returned non-JSON from /api/mcp ${tool}: ${body.slice(0, 200)}`, res.status, body);
    }
    if (msg.error) throw new Error(`loremax ${tool}: ${msg.error.message ?? JSON.stringify(msg.error)}`.slice(0, 500));
    const t = (msg.result?.content ?? []).find((c) => c?.type === "text")?.text ?? "";
    let out;
    try {
      out = JSON.parse(t);
    } catch {
      throw new Error(`loremax ${tool}: ${(t || "empty tool result").slice(0, 400)}`);
    }
    if (msg.result?.isError) {
      const errText = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out ?? "unknown error");
      if (/insufficient tokens/i.test(errText)) outOfFunds(errText);
      throw new Error(`loremax ${tool}: ${errText}`.slice(0, 500));
    }
    return out;
  }

  /** One /check of a generation; LoreMax answers a failed one with HTTP 500 and `status: "failed"` in the body. */
  async function check(generationId, { deadline } = {}) {
    try {
      return await restJson(`/api/v2/generations/${encodeURIComponent(generationId)}/check`, { method: "POST" }, { timeoutMs: 30_000, deadline });
    } catch (e) {
      let body;
      try {
        body = JSON.parse(e?.body ?? "");
      } catch {}
      if (body?.status === "failed") return body;
      throw e;
    }
  }

  return { cfg, key, hasKey: () => Boolean(rawKey()), baseUrl, usdPerToken, defaultWaitS, restJson, mcpCall, check };
}

/** What the agent should do with a finished generation's outputs. */
function outputsHint(artifacts, skipped = []) {
  if (skipped.length)
    return `${artifacts.length ? "some outputs were saved; " : ""}the left_on_cdn URLs could not be downloaded (failed or over the size cap) — they stay on LoreMax's CDN`;
  return artifacts.length
    ? "reference outputs as [media: artifacts/<path>]"
    : "LoreMax reported the generation as completed but returned no files to save";
}

/**
 * The body, read chunk by chunk so an undeclared size never buffers more than
 * the cap: null (and the download cancelled) once it goes over.
 */
async function readCapped(res, cap) {
  const chunks = [];
  let size = 0;
  // leaving the loop early cancels the stream
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Older cores keep only model and label on a job row (newer ones also keep the
 * track() params), so the token spend rides at the end of the label
 * ("hero · 12 tk"): a generation finished after a restart still records what it cost.
 */
const jobLabel = (note, tokensCost) => `${note ? `${note} · ` : ""}${tokensCost} tk`;
function fromJobLabel(label) {
  const m = /^(?:([\s\S]*) · )?(\d+(?:\.\d+)?) tk$/.exec(label ?? "");
  return m ? { note: m[1] ?? "", tokensCost: Number(m[2]) } : { note: label ?? "", tokensCost: 0 };
}

/** `flux-portrait`, `12`, `My Workflow!` → a file-name-safe slug. */
const slugOf = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "loremax";

/**
 * The local side: the workspace jail for references, downloading outputs into
 * the task's artifacts with provenance, and settling a finished generation
 * (spend + job row + the tool reply).
 */
export function createOutputs(ctx, lmx, { downloadCap = DOWNLOAD_CAP } = {}) {
  /** Local path → absolute, jailed to this workspace's artifacts or workdir. */
  function resolveLocal(ws, p) {
    const art = ctx.paths.workspaceArtifacts(ws);
    const work = ctx.paths.workspaceWorkdir(ws);
    const m = /(?:^|\/)artifacts\/(.*)$/.exec(p);
    const abs = m ? path.join(art, m[1]) : path.resolve(work, p);
    const inside = (f, root) => f === root || f.startsWith(root + path.sep);
    const jailed = (f, roots) => roots.some((r) => inside(f, r));
    if (!jailed(abs, [art, work])) throw new Error(`path is outside your workspace: ${p}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${p}`);
    // a symlink inside the workspace must not hand out a file from elsewhere
    const real = (f) => (fs.existsSync(f) ? fs.realpathSync(f) : f);
    if (!jailed(real(abs), [real(art), real(work)])) throw new Error(`path is outside your workspace: ${p}`);
    return abs;
  }

  /**
   * Download outputs into artifacts/<task|loremax>/ with provenance. Returns the
   * saved relative paths and the URLs left on the CDN (download failed or over
   * the cap), so the agent still learns where those outputs are.
   */
  async function saveOutputs(call, workflowSlug, generationId, result, note, generation) {
    // a workflow can return its media only as externalUrls (outputs.external): LoreMax counts that as a success too
    const urls = [result?.originalUrls, result?.previewUrls, result?.externalUrls].find((u) => u?.length) ?? [];
    const rels = [];
    const skipped = [];
    if (!urls.length) return { artifacts: rels, skipped };
    const folder = call.taskId ?? "loremax";
    const id = slugOf(generationId);
    const skip = (url, why) => {
      ctx.log.warn(`loremax output ${why}: ${url}`);
      skipped.push(url);
    };
    const overCap = `exceeds the ${Math.round(downloadCap / 1e6)}MB cap, left on the CDN`;
    const artRoot = ctx.paths.workspaceArtifacts(call.workspace);
    for (const [i, url] of urls.entries()) {
      let res;
      let buf;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
        if (!res.ok) {
          skip(url, `download failed (${res.status})`);
          continue;
        }
        // a declared size over the cap is skipped before pulling the body
        if (Number(res.headers.get("content-length")) > downloadCap) {
          await res.body?.cancel();
          skip(url, overCap);
          continue;
        }
        // the body read can time out or reset too: that output stays on the CDN, the rest still finishes
        buf = await readCapped(res, downloadCap);
      } catch (e) {
        skip(url, `download failed (${e?.message ?? e})`);
        continue;
      }
      if (!buf) {
        skip(url, overCap);
        continue;
      }
      const declared = String(result.contentTypes?.[i] ?? "").split(";")[0].trim().toLowerCase();
      const served = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      let urlExt = "";
      try {
        urlExt = (new URL(url).pathname.match(/\.([a-z0-9]{1,4})$/i)?.[1] ?? "").toLowerCase();
      } catch {}
      const ext = EXT_BY_MIME[declared] ?? EXT_BY_MIME[served] ?? (urlExt || "bin");
      const name = `${workflowSlug}-${id}${urls.length > 1 ? `-${i + 1}` : ""}.${ext}`;
      const rel = path.posix.join(folder, name);
      const abs = path.join(artRoot, rel);
      const tmp = `${abs}.${process.pid}-${Date.now()}.part`;
      // a full disk or a read-only folder must not lose a paid result: that output
      // stays on the CDN, and the spend is still recorded by finish
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // the name is predictable: a symlinked folder or file planted there must not
        // redirect the write outside the workspace — check the folder, then write a
        // fresh temp file and rename it over whatever entry sits at the name
        const realRoot = fs.realpathSync(artRoot);
        const realDir = fs.realpathSync(path.dirname(abs));
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
          skip(url, `not saved: artifacts/${folder} leads outside the workspace, left on the CDN`);
          continue;
        }
        fs.writeFileSync(tmp, buf, { flag: "wx" });
        fs.renameSync(tmp, abs);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        skip(url, `not saved (${e?.code ?? e?.message ?? e}), left on the CDN`);
        continue;
      }
      // the file is on disk: a provenance hiccup only costs the sidecar
      try {
        ctx.artifacts.annotate(call.workspace, rel, {
          agent: call.agent,
          taskId: call.taskId,
          description: `LoreMax ${generation?.workflow ?? workflowSlug} · generation ${generationId}${note ? ` · ${note}` : ""}`.slice(0, 300),
          action: "generated",
          // how it was made: the studio's Source card reads provider, workflow and params.image_urls
          generation,
        });
      } catch (e) {
        ctx.log.warn(`loremax provenance for ${rel}: ${e?.message ?? e}`);
      }
      rels.push(rel);
    }
    if (rels.length) ctx.artifacts.mirror(call.workspace, rels);
    return { artifacts: rels, skipped };
  }

  /**
   * A completed generation → files saved, spend recorded, job settled, tool reply.
   * job: { generationId, workflow, inputs?, references?, tokensCost?, trackedId?, note? }
   * check: LoreMax's /check reply with `result`.
   */
  async function finish(call, job, check) {
    const workflow = String(job.workflow ?? "");
    const tokensCost = Number(job.tokensCost) || 0;
    const costUsd = tokensCost * lmx.usdPerToken();
    const references = job.references ?? [];
    const generation = {
      provider: "LoreMax",
      workflow,
      params: { ...(job.inputs ?? {}), ...(references.length ? { image_urls: references } : {}) },
      externalId: String(job.generationId),
      ...(costUsd ? { costUsd } : {}),
    };
    const { artifacts, skipped } = await saveOutputs(call, slugOf(workflow), job.generationId, check?.result ?? {}, job.note ?? "", generation);
    ctx.usage.record({
      workspace: call.workspace,
      agent: call.agent,
      kind: "loremax",
      model: workflow,
      costUsd,
      units: tokensCost,
      unit: "tk",
      taskId: call.taskId,
    });
    const leftOnCdn = skipped.length ? { left_on_cdn: skipped } : {};
    if (job.trackedId && ctx.jobs)
      ctx.jobs.settle(job.trackedId, { status: "succeeded", result: { workspace: call.workspace, artifacts, tokensCost, ...leftOnCdn } });
    return {
      generation_id: String(job.generationId),
      status: "completed",
      workflow,
      artifacts,
      ...leftOnCdn,
      tokens_cost: tokensCost,
      ...(costUsd ? { cost_usd: costUsd } : {}),
      hint: outputsHint(artifacts, skipped),
    };
  }

  return { resolveLocal, saveOutputs, finish };
}

/** The wake line for a finished generation: saved paths, and the URLs left on the CDN (paid for all the same). */
function savedList(done) {
  const saved = done.artifacts.map((a) => `artifacts/${a}`).join(", ");
  const onCdn = done.left_on_cdn?.length
    ? `not downloaded (failed or over the size cap), still on LoreMax's CDN: ${done.left_on_cdn.join(", ")}`
    : "";
  return [saved, onCdn].filter(Boolean).join("; ") || "(LoreMax returned no files)";
}

/** A placeholder job row stands for a paid submission still under way: `submit:<uuid>`, never a generation. */
const isSubmitRow = (externalId) => String(externalId ?? "").startsWith("submit:");

/** `opts` is for tests only (the host passes just ctx): poll interval, clock and sleep. */
export default async function activate(ctx, { pollMs = POLL_MS, now = Date.now, sleep = realSleep } = {}) {
  const lmx = createClient(ctx, { now, sleep });
  const outputs = createOutputs(ctx, lmx);
  /**
   * What finish needs beyond the job row, by LoreMax generation id. Lost on a
   * restart: then rebuilt from the row's track() params, or on older cores from
   * job.model and job.label only.
   */
  const generations = new Map();
  /** The job a generation id stands for after a restart: from the row's params, else its label. */
  const fromRow = (generationId, row, found) => {
    const p = found?.result?.params;
    return {
      generationId,
      workflow: row?.model ?? "",
      // a submission placeholder's params describe no generation
      ...(p && typeof p === "object" && !p.submitting
        ? { inputs: p.inputs ?? {}, references: p.references ?? [], tokensCost: Number(p.tokensCost) || 0, note: p.note ?? "" }
        : fromJobLabel(row?.label)),
    };
  };
  /**
   * Generation ids a tool call or the watcher is polling right now: the others
   * leave them alone so one generation is never downloaded and settled twice.
   * Process-wide, not per activation: an update or dashboard toggle re-activates
   * (re-imports) the plugin while the old instance's tool calls are still polling.
   */
  const inFlight = (globalThis[Symbol.for("bridex.loremax.inFlight")] ??= new Set());
  // tools still register without a key: each call surfaces the Settings hint,
  // and setting the credential needs no restart
  if (!lmx.hasKey()) ctx.needsConfig("Add the LoreMax API key (Settings → Integrations, LOREMAX_API_KEY).");

  const { z } = ctx;
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const cap = (s, n = REPLY_CAP) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  const short = (s, n = 200) => String(s ?? "").slice(0, n);

  ctx.registerTool({
    name: "loremax_workflows",
    description:
      "LoreMax workflows of this organization (free). Without workflow_id: the list (id, visual_id, title, category), optionally filtered by query. With workflow_id: that workflow's input fields (keys, types, options) and its price in LoreMax tokens — ALWAYS read it before a paid loremax_generate: inputs are passed through exactly as these fields name them.",
    schema: {
      workflow_id: z.string().optional().describe("numeric id or visual id from the list; returns input fields and price"),
      query: z.string().optional().describe("case-insensitive filter over title, description, visual id and category"),
    },
    handler: async (args) => {
      const id = String(args.workflow_id ?? "").trim();
      if (!id) {
        const r = await lmx.restJson("/api/v1/workflows");
        const q = String(args.query ?? "").trim().toLowerCase();
        const workflows = (r.workflows ?? [])
          .map((w) => ({ id: w.id, visual_id: w.visualId, title: w.title, category: w.category, description: short(w.description) }))
          .filter((w) => !q || [w.title, w.description, w.visual_id, w.category].some((v) => String(v ?? "").toLowerCase().includes(q)));
        return text(cap(JSON.stringify({
          workflows,
          hint: workflows.length
            ? "call loremax_workflows with workflow_id to read its input fields and price before loremax_generate"
            : q ? `no workflow matches "${args.query}" — call without query for the full list` : "this organization has no workflows",
        }, null, 1)));
      }
      // get_workflow_details takes visual_id but also finds a workflow by its numeric id
      const d = (await lmx.mcpCall("get_workflow_details", { visual_id: id })) ?? {};
      const out = {
        workflow: { id: d.id ?? id, visual_id: d.visual_id, title: d.title, category: d.category, description: d.description },
        input_fields: d.input_fields ?? [],
        usage_hint: d.usage_hint,
        ...(d.pricing_variables_required ? { pricing_variables_required: d.pricing_variables_required } : {}),
      };
      // the price is a courtesy: a pricing hiccup must not hide the fields the agent needs
      try {
        const p = await lmx.mcpCall("get_pricing", { workflowId: id });
        out.token_cost = p?.tokenCost;
      } catch (e) {
        out.price = `unavailable: ${short(e?.message ?? e)}`;
      }
      return text(cap(JSON.stringify(out, null, 1)));
    },
  });

  /** Reference paths → absolute files, all checked before anything is sent (or paid for). */
  function loadReferences(ws, refs) {
    if (refs.length > MAX_REFS) throw new Error(`at most ${MAX_REFS} references per generation, got ${refs.length}`);
    return refs.map((p) => {
      const abs = outputs.resolveLocal(ws, p);
      const size = fs.statSync(abs).size;
      if (size > REF_CAP) throw new Error(`reference ${p} is ${(size / 1e6).toFixed(1)}MB; the plugin sends up to ${REF_CAP / 1024 / 1024}MB per file`);
      return abs;
    });
  }

  /** One paid execute request; an error whose outcome LoreMax leaves unknown is marked `ambiguous`. */
  async function execute(init) {
    try {
      // a synchronous workflow renders inside this request (and uploads go first): give it room —
      // aborting it would not stop LoreMax, so it is never cut short by the tool call's deadline
      return await lmx.restJson("/api/v2/workflow/execute", init, { timeoutMs: 600_000 });
    } catch (e) {
      // a timeout, a dropped connection (fetch's TypeError) or a gateway 5xx without
      // LoreMax's own JSON body (an edge 502/524 cutting a long sync render) leaves the
      // outcome unknown: LoreMax may already have taken the tokens and be rendering
      let body;
      try {
        body = JSON.parse(e?.body ?? "");
      } catch {}
      const unknown = e?.status != null
        ? e.status >= 500 && (body == null || typeof body !== "object")
        : e?.name === "TimeoutError" || e?.name === "AbortError" || e instanceof TypeError;
      if (!unknown) throw e;
      throw Object.assign(
        new Error(`loremax execute got no reply (${e?.message ?? e}) — LoreMax may have accepted and charged this generation; check its generation history before running it again`),
        { ambiguous: true },
      );
    }
  }

  /** The execute reply → the job, plus the outputs when it ran synchronously (null for an async one to poll). */
  function accepted(call, sub, { workflow, inputs, references, note }) {
    if (sub?.generationId == null) throw new Error(`loremax execute returned no generationId: ${JSON.stringify(sub).slice(0, 300)}`);
    const generationId = String(sub.generationId);
    const tokensCost = Number(sub.tokensCost) || 0;
    ctx.log.info(`@${call.agent} loremax ${workflow} → generation ${generationId} (${tokensCost} tk)`);
    // the workspace rides along: loremax_result answers only the one that started it
    const job = { generationId, workspace: call.workspace, workflow, inputs, references, tokensCost, note };
    // only an async reply has a job to poll: any other one ran synchronously and is finished
    // (a failed run is a 500); its outputs are already in hand, so it is finished directly
    // instead of spending a /check round trip on it
    const result = sub.async === true
      ? null
      : { originalUrls: sub.originalUrls ?? [], previewUrls: sub.previewUrls ?? [], externalUrls: sub.externalUrls ?? [], contentTypes: [] };
    return { job, result };
  }

  /**
   * Tracked from the first second: a restart mid-wait loses neither the
   * generation nor the tokens — the watcher finishes it and wakes the agent.
   */
  function trackGeneration(call, job) {
    job.trackedId = ctx.jobs
      ? ctx.jobs.track({
        workspace: call.workspace,
        agent: call.agent,
        taskId: call.taskId ?? null,
        sessionKey: call.sessionKey ?? null,
        runId: call.runId ?? null,
        externalId: job.generationId,
        model: job.workflow,
        label: jobLabel(job.note, job.tokensCost),
        // kept with the job row on newer cores (older ones ignore it): a restart keeps the provenance
        params: { inputs: job.inputs, references: job.references, tokensCost: job.tokensCost, note: job.note },
      })
      : null;
    generations.set(job.generationId, job);
  }

  /**
   * The placeholder row of a submission in progress: a restart while LoreMax
   * renders a slow request leaves it running, and the next watcher tells the agent.
   */
  function trackSubmit(call, { mode, workflow, note }) {
    const submitId = `submit:${crypto.randomUUID()}`;
    const trackedId = ctx.jobs.track({
      workspace: call.workspace,
      agent: call.agent,
      taskId: call.taskId ?? null,
      sessionKey: call.sessionKey ?? null,
      runId: call.runId ?? null,
      externalId: submitId,
      model: workflow,
      label: note,
      params: { submitting: true, mode, workflow, note },
    });
    inFlight.add(submitId);
    return { submitId, trackedId, call, what: `LoreMax ${workflow}${note ? ` (${note})` : ""}`, task: call.taskId ? ` (task ${call.taskId})` : "" };
  }

  function settleSubmit(ph, status, { generationId, error } = {}) {
    try {
      ctx.jobs.settle(ph.trackedId, {
        status,
        result: { workspace: ph.call.workspace, ...(generationId != null ? { generationId: String(generationId) } : {}) },
        ...(error ? { error: String(error).slice(0, 300) } : {}),
      });
    } finally {
      inFlight.delete(ph.submitId);
    }
  }

  const wakeSubmit = (ph, prompt) =>
    ctx.wakeAgent({
      workspace: ph.call.workspace,
      agent: ph.call.agent,
      key: `loremax-${ph.submitId}`,
      ...(ph.call.sessionKey ? { sessionKey: ph.call.sessionKey } : {}),
      prompt,
    });

  /** A synchronous result finished off the tool call (it came late, or too close to the deadline): save, bill, wake. */
  async function finishLate(ph, job, result) {
    const { generationId } = job;
    // loremax_result answers "being saved" meanwhile, and nothing else saves it
    inFlight.add(generationId);
    generations.set(generationId, job);
    try {
      const done = await outputs.finish(ph.call, { ...job, trackedId: null }, { result });
      settleSubmit(ph, "succeeded", { generationId });
      wakeSubmit(ph, `${ph.what} — generation ${generationId} finished: ${savedList(done)} — check them, then continue where you left off${ph.task}.`);
    } catch (e) {
      settleSubmit(ph, "failed", { generationId, error: e?.message ?? e });
      wakeSubmit(ph, `${ph.what} — generation ${generationId} finished, but saving its outputs failed: ${e?.message ?? e}${ph.task}.`);
    } finally {
      inFlight.delete(generationId);
      generations.delete(generationId);
    }
  }

  /** The submission answered after the tool call had replied `submitting`. */
  async function settleLate(ph, { sub, error }, base) {
    let got;
    try {
      if (error) throw error;
      got = accepted(ph.call, sub, base);
    } catch (e) {
      const msg = String(e?.message ?? e);
      settleSubmit(ph, "failed", { error: msg });
      wakeSubmit(ph, e?.ambiguous
        ? `${ph.what}: ${msg}${ph.task}.`
        : `${ph.what} FAILED: ${msg}. Decide whether to retry (other inputs or workflow) or report the blocker${ph.task}.`);
      return;
    }
    if (got.result) return finishLate(ph, got.job, got.result);
    // async: the real job row takes over before the placeholder goes; the watcher wakes the agent
    trackGeneration(ph.call, got.job);
    settleSubmit(ph, "succeeded", { generationId: got.job.generationId });
  }

  ctx.registerTool({
    name: "loremax_generate",
    description:
      `Run a LoreMax workflow (image or video) and wait for the result. inputs are passed through unchanged — name them exactly as loremax_workflows lists the workflow's input fields. references are artifacts/… paths or workspace files (each ≤ 20MB, up to 20) sent to LoreMax as files. Outputs are downloaded into this task's artifacts with provenance; the reply lists their paths. Every call is PAID in LoreMax tokens: read the workflow's fields and price with loremax_workflows first. Waits at most ${MAX_WAIT_S}s: if the wait runs out you get status in_progress (with a generation_id) or submitting back and are WOKEN when it lands (or poll loremax_result with the generation_id). Never call it again for a submitting reply.`,
    schema: {
      workflow_id: z.string().describe("numeric id or visual id from loremax_workflows"),
      inputs: z.record(z.string(), z.unknown()).describe("workflow inputs, exactly as loremax_workflows names the input fields"),
      references: z.array(z.string()).max(MAX_REFS).optional().describe("artifacts/<path> or workspace files sent as reference images/videos"),
      wait_s: z.number().int().min(10).max(MAX_WAIT_S).optional().describe(`seconds to wait before handing back (10..${MAX_WAIT_S}; default from config, ${DEFAULT_WAIT_S})`),
      note: z.string().max(200).optional().describe("short provenance note stored on the outputs (what this is for)"),
    },
    handler: async (args, call) => {
      // the budget covers the whole call from here: submission, polling and saving
      const start = now();
      const waitS = waitSeconds(args.wait_s, 10, lmx.defaultWaitS());
      const until = start + waitS * 1000;
      const deadline = start + MAX_WAIT_S * 1000;
      const workflow = String(args.workflow_id ?? "").trim();
      if (!workflow) throw new Error("workflow_id is required — pick one from loremax_workflows");
      const inputs = args.inputs ?? {};
      const references = (args.references ?? []).map(String);
      const files = loadReferences(call.workspace, references);
      const note = String(args.note ?? (typeof inputs.prompt === "string" ? inputs.prompt.slice(0, 120) : ""));
      const base = { workflow, inputs, references, note };

      let init;
      if (files.length) {
        // multipart: LoreMax routes each upload into image_urls / video_urls / audio_urls by its type
        const form = new FormData();
        form.append("workflowId", workflow);
        form.append("inputs", JSON.stringify(inputs));
        form.append("fileCount", String(files.length));
        files.forEach((abs, i) => {
          const type = MIME_BY_EXT[path.extname(abs).slice(1).toLowerCase()] ?? "application/octet-stream";
          form.append(`file_${i}`, new Blob([fs.readFileSync(abs)], { type }), path.basename(abs));
        });
        init = { method: "POST", body: form };
      } else {
        init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId: workflow, inputs }) };
      }

      // detached only where a late answer still reaches the agent (a job row that
      // survives a restart, and a wake); older cores block on the submission as before
      const ph = ctx.jobs && ctx.wakeAgent ? trackSubmit(call, { mode: "rest", workflow, note }) : null;
      const submission = execute(init).then((sub) => ({ sub }), (error) => ({ error }));
      let first;
      if (ph) {
        const timer = new AbortController();
        first = await Promise.race([submission, sleep(Math.max(0, until - now()), timer.signal).then(() => null)]);
        timer.abort();
      } else {
        first = await submission;
      }
      if (!first) {
        submission.then((o) => settleLate(ph, o, base)).catch((e) => ctx.log.warn(`loremax ${ph.submitId}: ${e?.message ?? e}`));
        return text(JSON.stringify({
          status: "submitting",
          workflow,
          hint: "submitted, still waiting for LoreMax — do NOT call loremax_generate again; end your turn, you will be WOKEN with the result",
        }, null, 1));
      }

      let got;
      try {
        if (first.error) throw first.error;
        got = accepted(call, first.sub, base);
      } catch (e) {
        if (ph) settleSubmit(ph, "failed", { error: e?.message ?? e });
        throw e;
      }
      const { job, result } = got;
      if (result) {
        // too close to the deadline for downloads: saved in the background, the agent is woken
        if (ph && deadline - now() < FINISH_RESERVE_MS) {
          finishLate(ph, job, result).catch((e) => ctx.log.warn(`loremax ${ph.submitId}: ${e?.message ?? e}`));
          return text(JSON.stringify({
            generation_id: job.generationId,
            status: "in_progress",
            tokens_cost: job.tokensCost,
            hint: "LoreMax finished it; the outputs are being saved — end your turn if nothing else is pending: you will be WOKEN with the files",
          }, null, 1));
        }
        try {
          const done = await outputs.finish(call, { ...job, trackedId: null }, { result });
          if (ph) settleSubmit(ph, "succeeded", { generationId: job.generationId });
          return text(JSON.stringify(done, null, 1));
        } catch (e) {
          if (ph) settleSubmit(ph, "failed", { generationId: job.generationId, error: e?.message ?? e });
          throw e;
        }
      }
      trackGeneration(call, job);
      if (ph) settleSubmit(ph, "succeeded", { generationId: job.generationId });
      return text(JSON.stringify(await waitFor(call, job, { until, deadline, waitS }), null, 1));
    },
  });

  ctx.registerTool({
    name: "loremax_result",
    description:
      `Status / result of a LoreMax generation (a generation_id from loremax_generate that ran out of wait time). Completed outputs are saved into artifacts exactly like loremax_generate does; an already finished one returns its saved paths. Free. wait_s keeps polling up to ${MAX_WAIT_S}s.`,
    schema: {
      generation_id: z.string().describe("generation_id from loremax_generate"),
      wait_s: z.number().int().min(0).max(MAX_WAIT_S).optional().describe(`keep polling this long (0..${MAX_WAIT_S}; default 0: one check)`),
    },
    handler: async (args, call) => {
      const start = now();
      const waitS = waitSeconds(args.wait_s, 0, 0);
      const generationId = String(args.generation_id ?? "").trim();
      if (!generationId) throw new Error("generation_id is required — loremax_generate hands it back");
      // job rows are per plugin, not per workspace, and LoreMax ids are sequential:
      // only this workspace's generations are reachable from here — an id nothing
      // here owns (unknown, or lost with a restart on a core without jobs) is refused
      const notYours = `generation ${generationId} was not started from this workspace — use the generation_id loremax_generate handed back`;
      // a submission placeholder is no generation: its outcome comes as a wake
      if (isSubmitRow(generationId)) throw new Error(notYours);
      const found = ctx.jobs?.find?.(generationId) ?? null;
      const row = ctx.jobs?.pending().find((j) => j.externalId === generationId);
      // settled rows carry the workspace in their result (the host's find() has no workspace column)
      const owner = generations.get(generationId)?.workspace ?? row?.workspace ?? found?.result?.workspace ?? found?.workspace;
      if (owner !== call.workspace) throw new Error(notYours);
      // settled already (by the tool or the watcher): the files are on disk, no new download
      if (found?.status === "succeeded") {
        const r = found.result ?? {};
        const artifacts = r.artifacts ?? [];
        return text(JSON.stringify({
          generation_id: generationId,
          status: "completed",
          artifacts,
          ...(r.left_on_cdn ? { left_on_cdn: r.left_on_cdn } : {}),
          tokens_cost: Number(r.tokensCost) || 0,
          hint: outputsHint(artifacts, r.left_on_cdn),
        }, null, 1));
      }
      if (found?.status === "failed") return text(JSON.stringify({ generation_id: generationId, status: "failed", error: found.error }, null, 1));
      // the generate call or the watcher is fetching it right now: one download, one settle
      if (inFlight.has(generationId))
        return text(JSON.stringify({ generation_id: generationId, status: "in_progress", hint: "being checked and saved right now — call loremax_result again in a moment" }, null, 1));
      // after a restart only the job row is left: its workflow, params (or label) and task
      // (the pending row's id when the core has no find(): the job must still settle, or the watcher saves it again)
      const job = generations.get(generationId) ?? { ...fromRow(generationId, row, found), trackedId: found?.id ?? row?.id ?? null };
      const budget = { until: start + waitS * 1000, deadline: start + MAX_WAIT_S * 1000, waitS };
      return text(JSON.stringify(await waitFor({ ...call, taskId: call.taskId ?? row?.taskId ?? null }, job, budget), null, 1));
    },
  });


  /**
   * Poll /check until completed (→ finish), failed (→ settle + throw) or `until`
   * passes (→ in_progress reply). `deadline` ends every request and Retry-After
   * wait; a result that lands too close to it is left to the watcher to save.
   */
  async function waitFor(call, job, { until, deadline, waitS }) {
    const { generationId, trackedId } = job;
    let landed = false;
    inFlight.add(generationId);
    try {
      for (;;) {
        let c;
        try {
          c = await lmx.check(generationId, { deadline });
        } catch (e) {
          // out of time (a request cut short, a Retry-After that does not fit): hand back, not a failure
          if (e?.deadline) break;
          // the generation goes on (and is tracked): don't present a status hiccup as a lost render
          throw new Error(`LoreMax generation ${generationId} status check failed: ${e?.message ?? e} — it may still finish; poll loremax_result with this generation_id`);
        }
        if (c?.status === "completed") {
          // downloads take time and the client gives up at 60 s: the watcher (or the next loremax_result) saves it
          if (deadline - now() < FINISH_RESERVE_MS) {
            landed = true;
            break;
          }
          const done = await outputs.finish(call, job, c);
          generations.delete(generationId);
          return done;
        }
        if (c?.status === "failed") {
          generations.delete(generationId);
          const error = String(c.error ?? "unknown error");
          if (trackedId && ctx.jobs)
            ctx.jobs.settle(trackedId, { status: "failed", result: { workspace: call.workspace }, error: `${error}${c.errorType ? ` (${c.errorType})` : ""}`.slice(0, 300) });
          throw new Error(`LoreMax generation ${generationId} failed: ${error}`);
        }
        if (now() >= until) break;
        await sleep(pollMs);
      }
    } finally {
      inFlight.delete(generationId);
    }
    if (landed)
      return {
        generation_id: String(generationId),
        status: "in_progress",
        tokens_cost: Number(job.tokensCost) || 0,
        hint: ctx.jobs
          ? "LoreMax finished it; the outputs are being saved — end your turn if nothing else is pending: you will be WOKEN with the files (or poll loremax_result)"
          : "LoreMax finished it — call loremax_result with this generation_id to save the outputs",
      };
    const waited = Math.round(waitS);
    return {
      generation_id: String(generationId),
      status: "in_progress",
      tokens_cost: Number(job.tokensCost) || 0,
      hint: ctx.jobs
        ? `still rendering after ${waited}s — end your turn if nothing else is pending: you will be WOKEN when it lands (or poll loremax_result)`
        : `still rendering after ${waited}s — call loremax_result with this generation_id (the work continues on LoreMax's side)`,
    };
  }

  // Reboot-proof: pending generations from the job rows are polled here, so a
  // run that died mid-wait (restart, crash, wait budget) still gets its
  // outputs saved and the agent woken in the session it came from.
  let watching = false;
  async function watchOnce() {
    if (watching || !ctx.jobs) return;
    watching = true;
    try {
      for (const j of ctx.jobs.pending()) {
        if (inFlight.has(j.externalId)) continue;
        // the list is read once per pass and a pass can take minutes (downloads):
        // a tool call may have finished this one meanwhile — don't save, bill and wake twice
        const cur = ctx.jobs.find?.(j.externalId);
        // cores without find(): a fresh pending() read is the only way to see it
        const settled = ctx.jobs.find ? cur && cur.status !== "running" : !ctx.jobs.pending().some((p) => p.id === j.id);
        if (settled) continue;
        inFlight.add(j.externalId);
        const wake = (prompt) =>
          ctx.wakeAgent?.({ workspace: j.workspace, agent: j.agent, key: `loremax-job:${j.id}`, ...(j.sessionKey ? { sessionKey: j.sessionKey } : {}), prompt });
        const what = `LoreMax generation ${j.externalId} (${j.model || "workflow"}${j.label ? ` — ${j.label}` : ""})`;
        const task = j.taskId ? ` (task ${j.taskId})` : "";
        try {
          // a placeholder no running submission holds was left by a process that died
          // mid-submission: nothing to /check, LoreMax may or may not have charged it
          if (isSubmitRow(j.externalId)) {
            ctx.jobs.settle(j.id, { status: "failed", result: { workspace: j.workspace }, error: "the submission was interrupted by a restart" });
            wake(`LoreMax ${j.model || "workflow"}${j.label ? ` (${j.label})` : ""}: the submission was interrupted by a restart; it may have been charged — check LoreMax history before running it again${task}.`);
            continue;
          }
          const expired = now() - Date.parse(j.createdAt) > GIVE_UP_MS;
          // ask LoreMax even past 6h: a job that finished while Bridex was down is
          // paid for and must still be saved — only a still-pending (or unreachable) one is given up
          let c = null;
          try {
            c = await lmx.check(j.externalId);
          } catch (e) {
            if (!expired) throw e;
            ctx.log.warn(`loremax job ${j.externalId}: ${e?.message ?? e}`);
          }
          if (c?.status === "completed") {
            const job = { ...(generations.get(j.externalId) ?? fromRow(j.externalId, j, cur)), trackedId: j.id };
            const call = { workspace: j.workspace, agent: j.agent, runId: null, sessionKey: j.sessionKey, taskId: j.taskId };
            const done = await outputs.finish(call, job, c);
            generations.delete(j.externalId);
            wake(`${what} finished: ${savedList(done)} — check them, then continue where you left off${task}.`);
          } else if (c?.status === "failed") {
            generations.delete(j.externalId);
            const error = `${c.error ?? "unknown error"}${c.errorType ? ` (${c.errorType})` : ""}`.slice(0, 300);
            ctx.jobs.settle(j.id, { status: "failed", result: { workspace: j.workspace }, error });
            wake(`${what} FAILED: ${error}. Decide whether to retry (other inputs or workflow) or report the blocker${task}.`);
          } else if (expired) {
            generations.delete(j.externalId);
            ctx.jobs.settle(j.id, { status: "failed", result: { workspace: j.workspace }, error: "gave up after 6h" });
            wake(`${what} did not finish within 6h and was given up. Check it on LoreMax or run it again${task}.`);
          }
        } catch (e) {
          // transient (network, rate limit, key): keep polling; the 6h give-up ends a dead one
          ctx.log.warn(`loremax job ${j.externalId}: ${e?.message ?? e}`);
        } finally {
          inFlight.delete(j.externalId);
        }
      }
    } catch (e) {
      // a jobs-table error must not become an unhandled rejection from setInterval
      ctx.log.warn(`loremax watcher: ${e?.message ?? e}`);
    } finally {
      watching = false;
    }
  }
  if (ctx.jobs) {
    const watcher = setInterval(watchOnce, WATCH_MS);
    watcher.unref?.();
    ctx.onShutdown?.(() => clearInterval(watcher));
  }

  ctx.registerCheck?.(async () => {
    if (!lmx.hasKey()) return { ok: false, message: "no key: LOREMAX_API_KEY is not set" };
    try {
      const b = await lmx.mcpCall("get_balance", {}, 15_000);
      const remaining = Number(b?.remaining);
      return remaining > 0
        ? { ok: true, message: `key works · ${remaining} tk left` }
        : { ok: false, message: "key works, but the balance is empty — top up LoreMax" };
    } catch (e) {
      return { ok: false, message: `LoreMax refused the key (${e?.status ?? short(e?.message ?? e)})` };
    }
  });

  // dashboard balance tile; polled by the UI, so cached a minute
  let balanceCache = { at: -Infinity, tiles: [] };
  ctx.registerStat?.(async () => {
    if (!lmx.hasKey()) return [];
    if (now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.tiles;
    try {
      const b = await lmx.mcpCall("get_balance", {}, 2_500);
      const remaining = Number(b?.remaining);
      if (!Number.isFinite(remaining)) return [];
      const limit = Number(b?.limit);
      const share = Number.isFinite(limit) && limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : undefined;
      const low = remaining <= 0 || (share !== undefined && share < 0.1);
      const tiles = [{ label: "LoreMax balance", value: `${remaining} tk`, sub: low ? "running out" : "balance", ...(share !== undefined ? { balance: share } : {}), low }];
      balanceCache = { at: now(), tiles };
      return tiles;
    } catch (e) {
      ctx.log.warn(`loremax balance: ${e?.message ?? e}`);
      return [];
    }
  });

  ctx.log.info(`loremax tools registered (loremax_workflows, loremax_generate, loremax_result)${ctx.jobs ? " + job watcher" : ""}`);
  // test seam: the host ignores the return value
  return { watchOnce };
}
