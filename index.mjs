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
 *         base_url: ${LOREMAX_BASE_URL}   # optional; empty = https://loremax.ai
 *         default_wait_s: 180             # how long loremax_generate waits before handing back a generation_id
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
const KEY_HINT = "LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax (or plugins.loremax.config.api_key)";

const EXT_BY_MIME = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
export const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT.jpeg = "image/jpeg";

const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After in seconds (the HTTP-date form is not used by LoreMax) → ms, capped. */
function retryAfterMs(header) {
  const s = Number(header);
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
export function createClient(ctx) {
  const cfg = {
    api_key: "${LOREMAX_API_KEY}",
    base_url: "${LOREMAX_BASE_URL}",
    default_wait_s: 180,
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

  // an empty balance: one needs-a-person card in the inbox, not a silent failed run
  // (ctx.billing exists on newer Bridex cores; older ones just skip it)
  const outOfFunds = (detail) =>
    ctx.billing?.outOfFunds?.({ provider: "LoreMax", what: "image and video generation (loremax plugin)", detail: String(detail).slice(0, 400) });

  async function restJson(p, init = {}, timeoutMs = 60_000) {
    const url = `${baseUrl()}${p}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: { "X-API-Key": key(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (res.status === 429) {
        if (attempt === 0) {
          await sleep(retryAfterMs(res.headers.get("retry-after")));
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
  /** One stateless tools/call (no initialize needed) → the tool's `data`. */
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
    // an SSE-framed reply carries the JSON-RPC message on its last data: line
    const raw = /^\s*(event|data):/m.test(body) && !body.trimStart().startsWith("{")
      ? (body.split("\n").filter((l) => l.startsWith("data:")).at(-1) ?? "").slice(5)
      : body;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      throw httpError(`loremax returned non-JSON from /api/mcp ${tool}: ${body.slice(0, 200)}`, res.status, body);
    }
    if (msg.error) throw new Error(`loremax ${tool}: ${msg.error.message ?? JSON.stringify(msg.error)}`.slice(0, 500));
    const result = msg.result ?? {};
    let out = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : null;
    if (!out) {
      const t = (result.content ?? []).find((c) => c?.type === "text")?.text ?? "";
      try {
        out = JSON.parse(t);
      } catch {
        if (result.isError) throw new Error(`loremax ${tool}: ${t.slice(0, 400)}`);
        return t;
      }
    }
    if (out?.success === false) {
      const e = out.error;
      const errText = typeof e === "string" ? e : (e?.message ?? JSON.stringify(e ?? "unknown error"));
      if (/insufficient tokens/i.test(errText)) outOfFunds(errText);
      throw new Error(`loremax ${tool}: ${errText}`.slice(0, 500));
    }
    return out && typeof out === "object" && "data" in out ? out.data : out;
  }

  /** One /check of a generation; LoreMax answers a failed one with HTTP 500 and `status: "failed"` in the body. */
  async function check(generationId) {
    try {
      return await restJson(`/api/v2/generations/${encodeURIComponent(generationId)}/check`, { method: "POST" }, 30_000);
    } catch (e) {
      let body;
      try {
        body = JSON.parse(e?.body ?? "");
      } catch {}
      if (body?.status === "failed") return body;
      throw e;
    }
  }

  return { cfg, key, hasKey: () => Boolean(rawKey()), baseUrl, usdPerToken, restJson, mcpCall, check };
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
    const abs = p.includes("artifacts/")
      ? path.join(art, p.slice(p.indexOf("artifacts/") + "artifacts/".length))
      : path.resolve(work, p);
    const inside = (root) => abs === root || abs.startsWith(root + path.sep);
    if (!inside(art) && !inside(work)) throw new Error(`path is outside your workspace: ${p}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${p}`);
    return abs;
  }

  /** Download outputs into artifacts/<task|loremax>/ with provenance; returns relative paths. */
  async function saveOutputs(call, workflowSlug, generationId, result, note, generation) {
    const urls = result?.originalUrls?.length ? result.originalUrls : (result?.previewUrls ?? []);
    if (!urls.length) return [];
    const folder = call.taskId ?? "loremax";
    const id = slugOf(generationId);
    const rels = [];
    for (const [i, url] of urls.entries()) {
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
      } catch (e) {
        ctx.log.warn(`loremax output download failed (${e?.message ?? e}): ${url}`);
        continue;
      }
      if (!res.ok) {
        ctx.log.warn(`loremax output download failed (${res.status}): ${url}`);
        continue;
      }
      // a declared size over the cap is skipped before pulling the body
      if (Number(res.headers.get("content-length")) > downloadCap) {
        ctx.log.warn(`loremax output exceeds the ${Math.round(downloadCap / 1e6)}MB cap, left on the CDN: ${url}`);
        await res.body?.cancel();
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > downloadCap) {
        ctx.log.warn(`loremax output exceeds the ${Math.round(downloadCap / 1e6)}MB cap, left on the CDN: ${url}`);
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
      const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      ctx.artifacts.annotate(call.workspace, rel, {
        agent: call.agent,
        taskId: call.taskId,
        description: `LoreMax ${generation?.workflow ?? workflowSlug} · generation ${generationId}${note ? ` · ${note}` : ""}`.slice(0, 300),
        action: "generated",
        // how it was made: the studio's Source card reads provider, workflow and params.image_urls
        generation,
      });
      rels.push(rel);
    }
    if (rels.length) ctx.artifacts.mirror(call.workspace, rels);
    return rels;
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
    const artifacts = await saveOutputs(call, slugOf(workflow), job.generationId, check?.result ?? {}, job.note ?? "", generation);
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
    if (job.trackedId && ctx.jobs) ctx.jobs.settle(job.trackedId, { status: "succeeded", result: { artifacts, tokensCost } });
    return {
      generation_id: String(job.generationId),
      status: "completed",
      workflow,
      artifacts,
      tokens_cost: tokensCost,
      ...(costUsd ? { cost_usd: costUsd } : {}),
      hint: artifacts.length
        ? "reference outputs as [media: artifacts/<path>]"
        : "LoreMax reported the generation as completed but returned no files to save",
    };
  }

  return { resolveLocal, saveOutputs, finish };
}

/** `opts` is for tests only (the host passes just ctx): poll interval and clock. */
export default async function activate(ctx, { pollMs = POLL_MS, now = Date.now } = {}) {
  const lmx = createClient(ctx);
  const outputs = createOutputs(ctx, lmx);
  /**
   * What finish needs beyond the job row, by LoreMax generation id. Lost on a
   * restart: the watcher then rebuilds from job.model and job.label only.
   */
  const generations = new Map();
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
      const d = await lmx.mcpCall("get_workflow_details", { workflowId: id });
      const w = d?.workflow ?? d ?? {};
      const out = {
        workflow: { id: w.id ?? id, visual_id: w.visualId ?? w.visual_id, title: w.title, category: w.category, description: w.description },
        input_fields: d?.input_fields ?? [],
        usage_hint: d?.usage_hint,
        ...(d?.pricing_variables_required ? { pricing_variables_required: d.pricing_variables_required } : {}),
      };
      // the price is a courtesy: a pricing hiccup must not hide the fields the agent needs
      try {
        const p = await lmx.mcpCall("get_pricing", { workflowId: id });
        out.token_cost = p?.tokenCost ?? p?.token_cost;
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

  ctx.registerTool({
    name: "loremax_generate",
    description:
      "Run a LoreMax workflow (image or video) and wait for the result. inputs are passed through unchanged — name them exactly as loremax_workflows lists the workflow's input fields. references are artifacts/… paths or workspace files (each ≤ 20MB, up to 20) sent to LoreMax as files. Outputs are downloaded into this task's artifacts with provenance; the reply lists their paths. Every call is PAID in LoreMax tokens: read the workflow's fields and price with loremax_workflows first. If the wait runs out you get a generation_id back and are WOKEN when it lands (or poll loremax_result).",
    schema: {
      workflow_id: z.string().describe("numeric id or visual id from loremax_workflows"),
      inputs: z.record(z.string(), z.unknown()).describe("workflow inputs, exactly as loremax_workflows names the input fields"),
      references: z.array(z.string()).max(MAX_REFS).optional().describe("artifacts/<path> or workspace files sent as reference images/videos"),
      wait_s: z.number().int().min(10).max(1500).optional().describe("seconds to wait before handing back the generation_id (default from config, 180)"),
      note: z.string().max(200).optional().describe("short provenance note stored on the outputs (what this is for)"),
    },
    handler: async (args, call) => {
      const workflow = String(args.workflow_id ?? "").trim();
      if (!workflow) throw new Error("workflow_id is required — pick one from loremax_workflows");
      const inputs = args.inputs ?? {};
      const references = (args.references ?? []).map(String);
      const files = loadReferences(call.workspace, references);
      const note = String(args.note ?? (typeof inputs.prompt === "string" ? inputs.prompt.slice(0, 120) : ""));

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
      const sub = await lmx.restJson("/api/v2/workflow/execute", init, 120_000);
      if (sub?.generationId == null) throw new Error(`loremax execute returned no generationId: ${JSON.stringify(sub).slice(0, 300)}`);
      const generationId = String(sub.generationId);
      const tokensCost = Number(sub.tokensCost) || 0;
      ctx.log.info(`@${call.agent} loremax ${workflow} → generation ${generationId} (${tokensCost} tk)`);
      // tracked from the first second: a restart mid-wait loses neither the
      // generation nor the tokens — the watcher finishes it and wakes the agent
      const trackedId = ctx.jobs
        ? ctx.jobs.track({
          workspace: call.workspace,
          agent: call.agent,
          taskId: call.taskId ?? null,
          sessionKey: call.sessionKey ?? null,
          runId: call.runId ?? null,
          externalId: generationId,
          model: workflow,
          label: note,
        })
        : null;
      const job = { generationId, workflow, inputs, references, tokensCost, trackedId, note };
      generations.set(generationId, job);

      const waitMs = Number(args.wait_s ?? lmx.cfg.default_wait_s) * 1000;
      const started = now();
      while (now() - started < waitMs) {
        let c;
        try {
          c = await lmx.check(generationId);
        } catch (e) {
          // the generation goes on (and is tracked): don't present a status hiccup as a lost render
          throw new Error(`LoreMax generation ${generationId} status check failed: ${e?.message ?? e} — it may still finish; poll loremax_result with this generation_id`);
        }
        if (c?.status === "completed") {
          generations.delete(generationId);
          return text(JSON.stringify(await outputs.finish(call, job, c), null, 1));
        }
        if (c?.status === "failed") {
          generations.delete(generationId);
          const error = String(c.error ?? "unknown error");
          if (trackedId) ctx.jobs.settle(trackedId, { status: "failed", error: `${error}${c.errorType ? ` (${c.errorType})` : ""}`.slice(0, 300) });
          throw new Error(`LoreMax generation ${generationId} failed: ${error}`);
        }
        await sleep(pollMs);
      }
      const waited = Math.round(waitMs / 1000);
      return text(JSON.stringify({
        generation_id: generationId,
        status: "in_progress",
        tokens_cost: tokensCost,
        hint: ctx.jobs
          ? `still rendering after ${waited}s — end your turn if nothing else is pending: you will be WOKEN when it lands (or poll loremax_result)`
          : `still rendering after ${waited}s — call loremax_result with this generation_id (the work continues on LoreMax's side)`,
      }, null, 1));
    },
  });

  ctx.log.info("loremax plugin active");
}
