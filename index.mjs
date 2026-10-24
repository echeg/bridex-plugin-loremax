import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GUIDE } from "./guide.mjs";

/**
 * LoreMax plugin: image, video, audio, 3D and text generation through the
 * organization's LoreMax workflows (or a curated MCP profile's). Agents list workflows and read a workflow's input fields
 * and price (both free), run one with workspace files as references, and get
 * the outputs saved into the task's artifacts with provenance and token spend.
 * The key is the managed LOREMAX_API_KEY credential (Settings → Integrations),
 * read per call so it can be set without a restart.
 *
 * loremax_workflows also carries the routing guide (guide.mjs: rules of thumb,
 * which workflow for which task), always intersected with the live catalog; in
 * profile mode the studio's own instructions and tool descriptions take
 * precedence over it. With allow_profile_edit, profile mode adds a fourth tool,
 * loremax_profile_edit: it rewrites the profile's texts in LoreMax (never its
 * bindings), previewing before it saves.
 *
 *   plugins:
 *     loremax:
 *       config:
 *         api_key: ${LOREMAX_API_KEY}     # optional; this is the default
 *         base_url: ${LOREMAX_BASE_URL}   # optional; this is the default, https:// only (the credential must be set: requires_env)
 *         default_wait_s: 45              # how long loremax_generate waits before handing back (10..50 s)
 *         usd_per_token: 0.001            # optional; tokens → USD for the spend charts
 *         profile_url: https://loremax.ai/api/mcp/s/<publicId>   # optional; a curated MCP profile (or its bare publicId)
 *         allow_profile_edit: false       # optional; profile mode only: agents may rewrite the profile's texts
 */

const DEFAULT_BASE_URL = "https://loremax.ai";
/** The process's one result watcher: `{ interval, generations, stop }` of the activation running it. */
const WATCHER_SLOT = Symbol.for("bridex.loremax.watcher");
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
/**
 * A core that cannot detach blocks on the paid call: it starts only with this
 * much of the call's time left after the profile's uploads (a short paid call
 * plus a first check).
 */
const PAID_CALL_RESERVE_MS = 15_000;
/** A synchronous reply without outputs is looked up (Text workflows): each read gets this long. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** The reboot-proof watcher's pass over pending jobs, and when it gives a generation up. */
const WATCH_MS = 15_000;
const GIVE_UP_MS = 6 * 3_600_000;
/**
 * How long the watcher waits before checking a pending generation again, by its
 * age: most finish within minutes, and every /check counts against the
 * organization's 1000 requests/hour that paid calls share.
 */
const checkEveryMs = (ageMs) => (ageMs <= 120_000 ? 15_000 : ageMs <= 1_800_000 ? 60_000 : 300_000);
/** The dashboard polls stat tiles; LoreMax's balance is read at most once a minute. */
const BALANCE_TTL_MS = 60_000;
/** A LoreMax MCP profile's publicId: 16 alphanumerics, served at /api/mcp/s/<publicId>. */
const PROFILE_ID_RE = /^[A-Za-z0-9]{16}$/;
const PROFILE_CAUSES = "the profile is unknown, disabled in LoreMax, or LOREMAX_API_KEY belongs to another organization";
const PROFILE_HINT =
  "set plugins.loremax.config.profile_url to the profile URL from LoreMax → Organization → MCP (https://<LoreMax>/api/mcp/s/<publicId>) or its 16-character publicId — or clear it to use every workflow of the organization";
/** Profile errors raised before any debit: the call was refused, nothing was charged. */
const PREFLIGHT_CODES = new Set(["SCHEMA_REVISION_MISMATCH", "INVALID_WORKFLOW_INPUT", "MEDIA_INPUT_INVALID", "WORKFLOW_UNAVAILABLE", "PROFILE_ORGANIZATION_MISMATCH"]);
const KEY_HINT = "LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax (or plugins.loremax.config.api_key)";
/** A profile's tools/list is reread after this long, or at once after one of the refresh codes. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_REFRESH_CODES = new Set(["SCHEMA_REVISION_MISMATCH", "WORKFLOW_UNAVAILABLE", "TOOL_NOT_FOUND"]);
/** Sent as clientInfo in the profile's initialize; kept equal to package.json's and plugin.yaml's version (a test checks). */
export const PLUGIN_VERSION = "0.3.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
/**
 * LoreMax appends its standard raw-MCP operating rules to a profile's
 * instructions; the plugin already does what they describe, so lines starting
 * with these are dropped and only the studio's own text is shown.
 */
const STANDARD_INSTRUCTION_PREFIXES = [
  "Each workflow tool call starts one paid generation",
  "Use tools/list for current schemas",
  "Poll check_generation",
  "Do not automatically resubmit",
  "on_behalf_of is a display-only",
  "An api_key argument must belong",
  "Media arguments take finalized organization URLs",
];
/** LoreMax's limit on a profile's description and each tool_description. */
const PROFILE_TEXT_MAX = 2000;
/** LoreMax hands names and descriptions back with URL query strings replaced by this: sent back, it would overwrite the real text. */
const REDACTED = "[redacted]";
const PROFILE_MCP_PAGE = "a person must fix it in LoreMax → Organization → MCP";
/** Profile tools that are never generations, whatever their schema says. */
const PROFILE_SERVICE_TOOLS = new Set(["get_balance", "check_generation", "request_upload_url", "finalize_upload", "upload_from_url"]);
/** Arguments the plugin fills in itself: the agent never sees them in a tool's schema. */
const INJECTED_ARGS = ["schema_revision", "api_key", "on_behalf_of"];

const EXT_BY_MIME = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-matroska": "mkv", "video/mp2t": "ts", "video/x-m4v": "m4v",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/flac": "flac", "audio/aac": "aac",
  "model/gltf-binary": "glb", "model/gltf+json": "gltf", "model/obj": "obj", "model/stl": "stl",
  "model/vnd.usdz+zip": "usdz", "model/fbx": "fbx",
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
 * A paid request that ended without LoreMax's answer — a timeout, a dropped
 * connection (fetch's TypeError), a gateway 5xx without LoreMax's own JSON body
 * (an edge 502/524 cutting a long sync render), a 2xx whose body is unreadable
 * (LoreMax answered, so it most likely ran) or a refused redirect (status 0: a
 * 302/303 after a POST may follow an accepted one) — leaves the outcome unknown:
 * LoreMax may already have taken the tokens and be rendering. → the
 * may-have-been-charged error (`ambiguous`), or `e` itself for a definite outcome.
 */
function unanswered(e, what) {
  if (!outcomeUnknown(e)) return e;
  return Object.assign(
    new Error(`loremax ${what} got no reply (${e?.message ?? e}) — LoreMax may have accepted and charged this generation; check its generation history before running it again`),
    { ambiguous: true },
  );
}

/** True when a request's error leaves its outcome unknown (see unanswered()). */
function outcomeUnknown(e) {
  let body;
  try {
    body = JSON.parse(e?.body ?? "");
  } catch {}
  return e?.status != null
    ? e.status === 0 || (e.status >= 200 && e.status < 300) || (e.status >= 500 && (body == null || typeof body !== "object"))
    : e?.name === "TimeoutError" || e?.name === "AbortError" || e instanceof TypeError;
}

/**
 * Config + the two LoreMax transports: REST (/api/v1, /api/v2 with X-API-Key)
 * and stateless JSON-RPC (Bearer) on the organization MCP endpoint (/api/mcp)
 * for what REST lacks — workflow details, pricing, balance — and on a profile
 * path (/api/mcp/s/<publicId>).
 */
export function createClient(ctx, { now = Date.now, sleep = realSleep } = {}) {
  const cfg = {
    api_key: "${LOREMAX_API_KEY}",
    base_url: "${LOREMAX_BASE_URL}",
    default_wait_s: DEFAULT_WAIT_S,
    usd_per_token: 0,
    profile_url: "",
    allow_profile_edit: false,
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
    // the key rides on every request: never in clear text
    if (!/^https:\/\/[^/]/i.test(raw)) {
      throw Object.assign(new Error(`LOREMAX_BASE_URL must be an https:// URL (Settings → Integrations → LoreMax, or plugins.loremax.config.base_url), got "${raw.slice(0, 200)}"`), { config: true });
    }
    return raw;
  };
  /**
   * profile_url → the profile's path on baseUrl() (`/api/mcp/s/<publicId>`), or
   * null when empty (REST mode). A value that is neither a publicId nor a profile
   * URL on the same origin as the key's LoreMax throws a config error: the key
   * would go to another host, or the agent would get no curated catalog.
   */
  const profilePath = () => {
    const raw = resolveRef(cfg.profile_url ?? "").trim();
    if (!raw) return null;
    if (PROFILE_ID_RE.test(raw)) return `/api/mcp/s/${raw}`;
    const bad = (why) => Object.assign(new Error(`loremax profile_url "${raw.slice(0, 200)}" ${why}: ${PROFILE_HINT}`), { config: true });
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw bad("is neither a profile URL nor a publicId");
    }
    if (u.protocol !== "https:") throw bad("must be an https:// URL");
    const base = new URL(baseUrl()).origin;
    if (u.origin !== base) throw bad(`is on ${u.origin}, not on the LoreMax base URL ${base}`);
    const m = /^\/api\/mcp\/s\/([A-Za-z0-9]{16})\/?$/.exec(u.pathname);
    if (!m || u.search || u.hash) throw bad("is not a profile URL (/api/mcp/s/<16-character publicId>)");
    return `/api/mcp/s/${m[1]}`;
  };
  // rewrites texts every client of the profile sees: on only for a literal true, never a "true" string
  const allowProfileEdit = () => cfg.allow_profile_edit === true;
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
    ctx.billing?.outOfFunds?.({ provider: "LoreMax", what: "media generation (loremax plugin)", detail: String(detail).slice(0, 400) });

  /**
   * One request with a single Retry-After retry on 429 → { res, body }. `deadline`
   * (epoch ms, optional) ends the request and any Retry-After wait by then.
   */
  async function send(url, init, label, { timeoutMs = 60_000, deadline } = {}) {
    for (let attempt = 0; ; attempt++) {
      const left = deadline == null ? Infinity : deadline - now();
      if (left <= 0) throw deadlineError(label);
      const ms = Math.min(timeoutMs, left);
      let res;
      let body;
      try {
        // a redirect would carry the key to wherever Location points: refused, never followed
        res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(ms) });
        body = await res.text();
      } catch (e) {
        // cut short by the deadline, not by the request's own timeout
        if (ms < timeoutMs && e?.name === "TimeoutError") throw deadlineError(label);
        // LoreMax answered with a redirect: refused (status 0), not a dropped connection
        if (e instanceof TypeError && /redirect/i.test(e.cause?.message ?? "")) {
          throw httpError(`loremax ${label}: redirected — refused, the key must not leave ${new URL(url).host}`, 0, "");
        }
        throw e;
      }
      if (res.status === 429) {
        if (attempt === 0) {
          const wait = retryAfterMs(res.headers.get("retry-after"));
          // a wait that does not fit before the deadline is not slept
          if (deadline != null && now() + wait > deadline) throw deadlineError(label);
          await sleep(wait);
          continue;
        }
        throw httpError(`loremax 429 ${label}: rate limited (LoreMax allows 60/min, 1000/h) — ${body.slice(0, 200)}`, 429, body);
      }
      return { res, body };
    }
  }

  async function restJson(p, init = {}, opts = {}) {
    const { res, body } = await send(`${baseUrl()}${p}`, { ...init, headers: { "X-API-Key": key(), ...(init.headers ?? {}) } }, p, opts);
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

  let rpcId = 0;
  const nextId = () => ++rpcId;
  /**
   * One stateless JSON-RPC POST (no initialize needed) to `path` on baseUrl()
   * with the Bearer key → the reply message, or for a batch array a Map of the
   * reply messages by id (the caller keeps batches ≤ 50). A profile path that
   * answers 404 is PROFILE_NOT_FOUND: LoreMax gives an unknown, a disabled and
   * another organization's profile the same 404, so the hint names all three.
   */
  async function rpc(path, payload, { label, ...opts } = {}) {
    const batch = Array.isArray(payload);
    label ??= `${path} ${batch ? `batch of ${payload.length}` : payload.method}`;
    const { res, body } = await send(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key()}`,
        "Content-Type": "application/json",
        // Streamable HTTP clients announce both; LoreMax answers with plain JSON
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    }, label, opts);
    if (res.status === 404 && path.startsWith("/api/mcp/s/")) {
      throw Object.assign(
        new Error(`loremax ${label}: profile not found (HTTP 404) — ${PROFILE_CAUSES}; ${PROFILE_HINT}`),
        { status: 404, body, code: "PROFILE_NOT_FOUND", retryable: false, charged: false },
      );
    }
    if (!res.ok) {
      if (res.status === 402 || /insufficient tokens/i.test(body)) outOfFunds(body);
      throw httpError(`loremax ${res.status} ${label}: ${body.slice(0, 400)}`, res.status, body);
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      throw httpError(`loremax returned non-JSON from ${label}: ${body.slice(0, 200)}`, res.status, body);
    }
    if (!batch) return msg;
    // a batch the server could not read at all comes back as one error message
    if (!Array.isArray(msg)) throw new Error(`loremax ${label}: ${msg?.error?.message ?? JSON.stringify(msg).slice(0, 200)}`.slice(0, 500));
    return new Map(msg.filter((m) => m && m.id != null).map((m) => [m.id, m]));
  }

  /**
   * A tools/call reply message → the tool's data. LoreMax puts the data itself
   * as JSON in the text content; a failed tool sets `isError` with
   * `{"error": "…", "errorCode"?, "details"?}` there — code and details ride on
   * the thrown error as `code` / `details`, and a preflight code adds
   * `charged: false`. A never-bound tool name (JSON-RPC -32601) is TOOL_NOT_FOUND.
   */
  function toolResult(name, msg) {
    if (msg == null) throw new Error(`loremax ${name}: no reply to this call`);
    if (msg.error) {
      const e = new Error(`loremax ${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`.slice(0, 500));
      if (msg.error.code === -32601) Object.assign(e, { code: "TOOL_NOT_FOUND", charged: false });
      throw e;
    }
    const t = (msg.result?.content ?? []).find((c) => c?.type === "text")?.text ?? "";
    let out;
    try {
      out = JSON.parse(t);
    } catch {
      throw new Error(`loremax ${name}: ${(t || "empty tool result").slice(0, 400)}`);
    }
    if (msg.result?.isError) {
      const errText = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out ?? "unknown error");
      const code = typeof out?.errorCode === "string" ? out.errorCode : undefined;
      if (/insufficient tokens/i.test(errText) || code === "INSUFFICIENT_TOKENS") outOfFunds(errText);
      throw Object.assign(new Error(`loremax ${name}: ${errText}`.slice(0, 500)), {
        code,
        // LoreMax answered and refused or failed the call: a definite outcome, not a lost reply
        toolError: true,
        ...(out?.details != null ? { details: out.details } : {}),
        ...(PREFLIGHT_CODES.has(code) ? { charged: false } : {}),
      });
    }
    return out;
  }

  /** One tools/call on `path` (`/api/mcp` or a profile path) → the tool's data. */
  async function toolCall(path, name, args = {}, opts = {}) {
    const msg = await rpc(path, { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name, arguments: args } }, { ...opts, label: `${path} ${name}` });
    return toolResult(name, msg);
  }

  /** A tool of the organization-wide endpoint, for what REST lacks — workflow details, pricing, balance. */
  const mcpCall = (tool, args = {}, opts = {}) => toolCall("/api/mcp", tool, args, opts);

  /** One /check of a generation; LoreMax answers a failed one with HTTP 500 and `status: "failed"` in the body. */
  async function check(generationId, { deadline, timeoutMs = 30_000 } = {}) {
    try {
      return await restJson(`/api/v2/generations/${encodeURIComponent(generationId)}/check`, { method: "POST" }, { timeoutMs, deadline });
    } catch (e) {
      let body;
      try {
        body = JSON.parse(e?.body ?? "");
      } catch {}
      if (body?.status === "failed") return body;
      throw e;
    }
  }

  return { cfg, key, hasKey: () => Boolean(rawKey()), baseUrl, profilePath, allowProfileEdit, usdPerToken, defaultWaitS, restJson, rpc, nextId, toolResult, toolCall, mcpCall, check };
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * One profile tools/list entry → a generation tool as the dispatcher uses it, or
 * null for a service tool or a nameless entry; throws for a generation tool it
 * cannot use. A generation tool is one whose schema takes `schema_revision`
 * (`_meta` is only for identity); `warn(key, message)` logs once per key.
 */
function profileTool(t, warn) {
  const name = isObj(t) && typeof t.name === "string" ? t.name.trim() : "";
  const schema = isObj(t) ? t.inputSchema : null;
  const props = isObj(schema) && isObj(schema.properties) ? schema.properties : null;
  if (!name || !props || !Object.hasOwn(props, "schema_revision") || PROFILE_SERVICE_TOOLS.has(name)) return null;
  const revision = props.schema_revision?.enum?.[0];
  // a generation tool that cannot be called: the caller skips it, it is no service tool either
  if (typeof revision !== "string" || !revision) throw new Error("no schema_revision value");
  const agentSchema = structuredClone(schema);
  for (const k of INJECTED_ARGS) delete agentSchema.properties[k];
  if (Array.isArray(agentSchema.required)) agentSchema.required = agentSchema.required.filter((k) => !INJECTED_ARGS.includes(k));
  const fileArgs = [];
  for (const [arg, p] of Object.entries(agentSchema.properties)) {
    const m = isObj(p) ? p["x-loremax-media"] : null;
    if (!isObj(m)) continue;
    // an unknown version keeps the argument a plain URL string: its semantics are not version 1's
    if (m.version !== 1 || typeof m.mediaType !== "string") {
      warn(`media:${m.version}`, `loremax profile tool ${name}: x-loremax-media version ${JSON.stringify(m.version)} is unknown — ${arg} is passed as a plain URL`);
      continue;
    }
    fileArgs.push({
      name: arg,
      mediaType: m.mediaType,
      role: m.role ?? "source",
      cardinality: m.cardinality ?? (p.type === "array" ? "array" : "single"),
      acceptedFormats: Array.isArray(m.acceptedFormats) ? m.acceptedFormats : [],
      constraints: isObj(m.constraints) ? m.constraints : {},
      ...(isObj(m.pairedWith) ? { pairedWith: m.pairedWith } : {}),
    });
  }
  const w = isObj(t._meta) ? t._meta["loremax.ai/workflow"] : null;
  let identity;
  if (isObj(w)) {
    const { workflowId, visualId, title, category, contentType, pipeline } = w;
    identity = { workflowId, visualId, title, category, contentType, pipeline };
  } else {
    identity = { title: t.title ?? name };
    warn(`identity:${name}`, `loremax profile tool ${name} has no _meta loremax.ai/workflow — identified by its title only`);
  }
  return {
    name,
    title: typeof t.title === "string" && t.title ? t.title : identity.title ?? name,
    description: typeof t.description === "string" ? t.description : "",
    revision,
    agentSchema,
    fileArgs,
    limits: isObj(schema["x-loremax-limits"]) ? schema["x-loremax-limits"] : null,
    identity,
  };
}

/**
 * The profile's catalog: its tools/list, cached for CATALOG_TTL_MS and reread on
 * `force` or after a refresh code (`refreshAfter`). LoreMax never sends
 * list-changed notifications, so these are the only ways a change shows up.
 * get() → { tools: Map name → generation tool, service: [names], fetchedAt }.
 */
export function createProfileCatalog(lmx, { now = Date.now, log } = {}) {
  let cached = null;
  let loading = null;
  // bumped by markStale(), as in createProfileInstructions
  let epoch = 0;
  const warned = new Set();
  const warn = (k, msg) => {
    if (warned.has(k)) return;
    warned.add(k);
    log?.warn?.(msg);
  };

  async function load() {
    const path = lmx.profilePath();
    const entries = [];
    let cursor;
    // a profile holds up to 25 tools; pages are followed only in case the server ever paginates
    for (let page = 0; page < 10; page++) {
      const msg = await lmx.rpc(path, { jsonrpc: "2.0", id: lmx.nextId(), method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }, { timeoutMs: LOOKUP_TIMEOUT_MS });
      if (msg?.error) throw new Error(`loremax ${path} tools/list: ${msg.error.message ?? JSON.stringify(msg.error)}`.slice(0, 500));
      const list = msg?.result?.tools;
      if (Array.isArray(list)) entries.push(...list);
      cursor = typeof msg?.result?.nextCursor === "string" && msg.result.nextCursor ? msg.result.nextCursor : null;
      if (!cursor) break;
    }
    const tools = new Map();
    const service = [];
    for (const t of entries) {
      let g = null;
      try {
        g = profileTool(t, warn);
      } catch (e) {
        warn(`bad:${t?.name}`, `loremax profile tool ${String(t?.name ?? "?").slice(0, 100)} is unreadable — skipped (${e?.message ?? e})`);
        continue;
      }
      if (g) {
        if (!tools.has(g.name)) tools.set(g.name, g);
      } else if (isObj(t) && typeof t.name === "string" && t.name.trim()) service.push(t.name.trim());
    }
    return { tools, service, fetchedAt: now() };
  }

  /**
   * The catalog, reread when stale or forced; concurrent callers share one
   * tools/list. Each caller waits for it until its own `deadline` only: the
   * shared read is bounded per page, never by the caller that started it.
   */
  async function get({ force = false, deadline } = {}) {
    if (!force && cached && now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
    if (deadline != null && deadline - now() <= 0) throw deadlineError("tools/list");
    if (!loading) {
      const started = epoch;
      const p = load().then(
        (c) => {
          if (started === epoch) cached = c;
          if (loading === p) loading = null;
          return c;
        },
        (e) => {
          if (loading === p) loading = null;
          throw e;
        },
      );
      loading = p;
    }
    if (deadline == null) return loading;
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(deadlineError("tools/list")), deadline - now());
    });
    return Promise.race([loading, late]).finally(() => clearTimeout(timer));
  }

  /** The next get() rereads (after the profile itself was edited); a read already under way neither fills the cache nor serves later callers. */
  function markStale() {
    epoch++;
    loading = null;
    if (cached) cached = { ...cached, fetchedAt: -Infinity };
  }

  /** Marks the cache stale when `err` says the catalog changed; true if it did. */
  function refreshAfter(err) {
    if (!CATALOG_REFRESH_CODES.has(err?.code)) return false;
    markStale();
    return true;
  }

  return { get, refreshAfter, markStale };
}

/** A profile's initialize instructions → the studio's own text (LoreMax's standard lines dropped), or null if none is left. */
export function cleanInstructions(raw) {
  if (typeof raw !== "string") return null;
  const kept = raw.split("\n").filter((line) => !STANDARD_INSTRUCTION_PREFIXES.some((p) => line.trimStart().startsWith(p)));
  return kept.join("\n").trim() || null;
}

/**
 * The profile's instructions, read lazily: one initialize, sent only when asked
 * (the list view), cached for CATALOG_TTL_MS; concurrent callers share it. The
 * catalog load, generation and uploads never send it. A failed or malformed
 * initialize is null for that call and not cached — the tools work without it,
 * and a dead profile is reported by the catalog read. get() → string | null.
 */
export function createProfileInstructions(lmx, { now = Date.now, log } = {}) {
  let cached = null;
  let loading = null;
  // bumped by invalidate(): a read started before it neither fills the cache nor serves later callers
  let epoch = 0;

  async function load() {
    const path = lmx.profilePath();
    const started = epoch;
    try {
      const msg = await lmx.rpc(path, {
        jsonrpc: "2.0",
        id: lmx.nextId(),
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bridex-plugin-loremax", version: PLUGIN_VERSION } },
      }, { timeoutMs: LOOKUP_TIMEOUT_MS });
      if (msg?.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
      const raw = msg?.result?.instructions;
      if (typeof raw !== "string") throw new Error("no instructions in the reply");
      const text = cleanInstructions(raw);
      if (started === epoch) cached = { text, fetchedAt: now() };
      return text;
    } catch (e) {
      log?.warn?.(`loremax ${path} initialize: ${String(e?.message ?? e).slice(0, 300)} — listing without the profile's instructions`);
      return null;
    }
  }

  /** The cleaned text; each caller waits for the shared read until its own `deadline` only (null when out of time). */
  async function get({ deadline } = {}) {
    if (cached && now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.text;
    if (deadline != null && deadline - now() <= 0) return null;
    if (!loading) {
      const p = load().finally(() => {
        if (loading === p) loading = null;
      });
      loading = p;
    }
    if (deadline == null) return loading;
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), deadline - now());
    });
    return Promise.race([loading, late]).finally(() => clearTimeout(timer));
  }

  /** Forces the next get() to reread (after the profile's texts were edited). */
  function invalidate() {
    epoch++;
    cached = null;
    loading = null;
  }

  return { get, invalidate };
}

/**
 * The profile's numeric id in LoreMax's management API, which knows profiles by
 * it, not by the publicId: one GET /api/v2/mcp-servers, matched by public_id and
 * kept in memory. → profileManagementId({ deadline }) → number.
 */
export function createProfileManagementId(lmx) {
  // profile_url is fixed for the client's life: one id
  let id = null;
  return async function profileManagementId({ deadline } = {}) {
    if (id != null) return id;
    const publicId = lmx.profilePath().slice("/api/mcp/s/".length);
    const body = await lmx.restJson("/api/v2/mcp-servers", {}, { timeoutMs: LOOKUP_TIMEOUT_MS, deadline });
    const found = (Array.isArray(body?.profiles) ? body.profiles : []).find((p) => isObj(p) && p.public_id === publicId && Number.isSafeInteger(p.id));
    if (!found) {
      throw Object.assign(
        new Error(`loremax: profile ${publicId} is not among this organization's MCP profiles — it is unknown, disabled or deleted in LoreMax, or LOREMAX_API_KEY belongs to another organization; ${PROFILE_HINT}`),
        { code: "PROFILE_NOT_FOUND" },
      );
    }
    id = found.id;
    return id;
  };
}

/**
 * The agent's edit request → { description?: string, tools: Map name → string },
 * checked before any request: something to change, each text a string (null or ""
 * clears it, sent as "") of at most PROFILE_TEXT_MAX chars, a tool named once.
 */
function profileEditRequest(args) {
  const fail = (why) => {
    throw new Error(`loremax_profile_edit: ${why}`);
  };
  const textOf = (v, field) => {
    if (v == null) return "";
    if (typeof v !== "string") fail(`${field} must be a string, or null to clear it`);
    if (v.length > PROFILE_TEXT_MAX) fail(`${field} is ${v.length} characters — LoreMax takes at most ${PROFILE_TEXT_MAX}`);
    return v;
  };
  const out = { tools: new Map() };
  if (args.instructions !== undefined) out.description = textOf(args.instructions, "instructions");
  if (args.tools != null && !Array.isArray(args.tools)) fail("tools must be a list of { tool, description }");
  for (const t of args.tools ?? []) {
    const name = isObj(t) && typeof t.tool === "string" ? t.tool.trim() : "";
    if (!name) fail("every tools[] entry needs the tool's current name in `tool`");
    if (out.tools.has(name)) fail(`tool "${name.slice(0, 100)}" is listed twice`);
    if (!isObj(t) || !("description" in t)) fail(`tools[] entry "${name.slice(0, 100)}" needs a description (null clears it)`);
    out.tools.set(name, textOf(t.description, `the description of "${name.slice(0, 100)}"`));
  }
  if (out.description === undefined && !out.tools.size) fail("nothing requested — pass instructions and/or tools");
  return out;
}

/**
 * LoreMax's profile (GET /api/v2/mcp-servers/<id>) + the request → the strict PUT
 * body (`{ name, description, is_active, tools: [{ workflow_id, tool_name,
 * tool_description }] }` in position order, bindings untouched), the changes and
 * `linked`: the unchanged fields holding a URL, sent back as LoreMax read them.
 * Refuses an unknown tool name and any text sent with REDACTED in it, changed or
 * not: LoreMax would store the redaction in place of the real text.
 */
function profileEditPlan(profile, req) {
  const fail = (why) => {
    throw new Error(`loremax_profile_edit: ${why}`);
  };
  // sort is stable: tools at the same position keep LoreMax's order
  const bound = [...profile.tools].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const names = bound.map((t) => t.tool_name);
  for (const name of req.tools.keys()) {
    if (!names.includes(name)) fail(`no tool "${name.slice(0, 100)}" is bound to this profile — tools: ${names.length ? names.join(", ") : "(none)"}`);
  }
  const changes = [];
  const unchanged = [];
  const field = (label, before, wanted) => {
    const was = before ?? "";
    if (wanted === undefined || wanted === was) {
      unchanged.push([label, was]);
      return before;
    }
    // usually the redacted `before` copied into the new text: the real query string would be lost all the same
    if (wanted.includes(REDACTED)) fail(`the new ${label} contains "${REDACTED}" (LoreMax hides URL query strings when reading the profile) — saving would store it in place of the real URL; ${PROFILE_MCP_PAGE}`);
    changes.push({ field: label, before: was, after: wanted });
    return wanted;
  };
  unchanged.push(["name", profile.name ?? ""]);
  const body = {
    name: profile.name,
    description: field("description", profile.description, req.description),
    is_active: profile.is_active,
    tools: bound.map((t) => {
      unchanged.push([`tool name ${t.tool_name}`, t.tool_name ?? ""]);
      return { workflow_id: t.workflow_id, tool_name: t.tool_name, tool_description: field(`tool:${t.tool_name}`, t.tool_description, req.tools.get(t.tool_name)) };
    }),
  };
  if (changes.length) {
    const hit = unchanged.find(([, v]) => String(v).includes(REDACTED));
    if (hit) fail(`the profile's ${hit[0]} contains "${REDACTED}" (LoreMax hides URL query strings when reading it) — saving would overwrite the real text; ${PROFILE_MCP_PAGE}`);
  }
  // the same read drops a URL's #fragment and user:pass@ with no marker to refuse on: only a warning can say so
  const linked = unchanged.filter(([, v]) => /https?:\/\//i.test(String(v))).map(([label]) => label);
  return { body, changes, linked };
}

/** A LoreMax workflows[] list → the ones it marks compatible: false. */
const incompatibleOf = (workflows) => (Array.isArray(workflows) ? workflows : []).filter((w) => isObj(w) && w.compatible === false);

/**
 * loremax_profile_edit's core: rewrites the profile's description and its bound
 * tools' descriptions, never bindings, names or is_active. Preview (default):
 * PUT ?preview=true, nothing saved. Apply: the profile is read right before the
 * PUT, so the diff is against what LoreMax holds now (no ETag: an edit landing
 * between that read and the PUT is lost). `onSaved` runs after a save, and after
 * one whose outcome is unknown. edit(args, { deadline }) → { applied, incompatible?, hint, warning?, changes }.
 */
export function createProfileEditor(lmx, { profileManagementId, onSaved } = {}) {
  return async function edit(args, { deadline } = {}) {
    const req = profileEditRequest(isObj(args) ? args : {});
    const apply = args?.apply === true;
    const id = await profileManagementId({ deadline });
    const p = `/api/v2/mcp-servers/${id}`;
    const refused = (e) => {
      if (e?.status === 404) {
        return Object.assign(new Error(`loremax_profile_edit: LoreMax has no profile ${id} any more — it was deleted, or LOREMAX_API_KEY belongs to another organization; ${PROFILE_HINT}`), { code: "PROFILE_NOT_FOUND" });
      }
      if (e?.status === 400) {
        let b = null;
        try {
          b = JSON.parse(e.body);
        } catch {}
        const issues = b?.issues ?? b?.error ?? b?.message ?? String(e.body ?? "").slice(0, 400);
        const bad = incompatibleOf(b?.workflows);
        return new Error(`loremax_profile_edit: LoreMax refused the profile (400): ${JSON.stringify(issues).slice(0, 600)}${bad.length ? ` — incompatible workflows: ${JSON.stringify(bad).slice(0, 600)}` : ""}`);
      }
      return e;
    };
    let got;
    try {
      got = await lmx.restJson(p, {}, { timeoutMs: LOOKUP_TIMEOUT_MS, deadline });
    } catch (e) {
      throw refused(e);
    }
    if (!isObj(got?.profile) || !Array.isArray(got.profile.tools)) throw new Error(`loremax_profile_edit: LoreMax's ${p} has no readable profile`);
    const { body, changes, linked } = profileEditPlan(got.profile, req);
    if (!changes.length) return { applied: false, hint: "nothing to change: the profile already has these texts", changes };
    const urls = (saved) => (linked.length ? {
      warning: `unchanged texts with a URL (${linked.join(", ")}): LoreMax reads a URL without its #fragment and user:pass@, leaving no "${REDACTED}" marker, so ${saved
        ? "they were sent back without any such part — pass a text in full in another edit to restore it"
        : "saving sends them back without those parts — to keep one, pass that text in full in this edit"}`,
    } : {});
    const put = (preview) => lmx.restJson(`${p}${preview ? "?preview=true" : ""}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { timeoutMs: LOOKUP_TIMEOUT_MS * 3, deadline });

    if (!apply) {
      let r;
      try {
        r = await put(true);
      } catch (e) {
        throw refused(e);
      }
      const incompatible = incompatibleOf(r?.workflows ?? got.workflows);
      // before the changes, so cap() never cuts the verdict
      return {
        applied: false,
        incompatible,
        hint: incompatible.length
          ? `LoreMax would refuse this save: the profile binds incompatible workflows — ${PROFILE_MCP_PAGE}`
          : "nothing saved yet — show these changes, then call again with apply: true to save",
        ...urls(false),
        changes,
      };
    }
    // the read above is the fresh one: a save never goes ahead on a profile LoreMax already marks incompatible
    const incompatible = incompatibleOf(got.workflows);
    if (incompatible.length) {
      throw new Error(`loremax_profile_edit: not saved — the profile binds incompatible workflows (${JSON.stringify(incompatible).slice(0, 600)}); ${PROFILE_MCP_PAGE}`);
    }
    try {
      await put(false);
    } catch (e) {
      // a 2xx whose body is not JSON (a 204) is a save all the same
      if (!(e?.status >= 200 && e?.status < 300)) {
        if (!e?.deadline && !outcomeUnknown(e)) throw refused(e);
        onSaved?.();
        throw new Error(`loremax_profile_edit: the save got no reply (${e?.message ?? e}) — it may or may not have been stored; preview again to see what LoreMax holds`);
      }
    }
    onSaved?.();
    return { applied: true, hint: "saved: every client of the profile sees the new texts", ...urls(true), changes };
  };
}

/**
 * loremax_workflows' profile list: one line per generation tool, filtered by `query` over tool, title,
 * category and visual id. Before the tools, so cap() never cuts them: the studio's `instructions`,
 * then the guide's `recommended` routes over the profile's tools (by tool name) and its `rules`
 * (omitted with a query); a tool the guide knows gets a short `use_for`.
 */
function profileList(c, query, { guide, instructions = null } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  const all = [...c.tools.values()];
  const tools = all
    .filter((t) => !q || [t.name, t.title, t.identity.category, t.identity.visualId].some((v) => String(v ?? "").toLowerCase().includes(q)))
    .map((t) => {
      const entry = guideEntry(guide, t.identity);
      return {
        tool: t.name,
        title: t.title,
        category: t.identity.category ?? null,
        description: t.description.slice(0, 200),
        ...(entry?.use_for ? { use_for: entry.use_for } : {}),
        required: Array.isArray(t.agentSchema.required) ? t.agentSchema.required : [],
        file_args: t.fileArgs.map(({ name, mediaType, cardinality }) => ({ name, mediaType, cardinality })),
      };
    });
  const recommended = recommendedFrom(guide, all.map((t) => ({ ...t.identity, title: t.title, tool: t.name })), q).map((rt) => ({
    task: rt.task,
    tools: rt.picks.map(({ item, entry }) => ({ tool: item.tool, title: item.title, why: entry?.use_for })),
  }));
  const rules = !q && Array.isArray(guide?.rules) && guide.rules.length ? guide.rules : undefined;
  return {
    instructions,
    ...(recommended.length ? { recommended } : {}),
    ...(rules ? { rules } : {}),
    tools,
    // a query matching a route's task keeps its tools in recommended, even when no row matches
    hint: tools.length || recommended.length
      ? `call loremax_workflows with tool to read its argument schema before loremax_generate. ${PROFILE_PRECEDENCE}`
      : q ? `no tool matches "${String(query).slice(0, 100)}" — call without query for the full list` : "this profile has no workflows — add some in LoreMax → Organization → MCP",
  };
}

const PROFILE_PRECEDENCE =
  "The studio's instructions and each tool's own description take precedence over the generic guide (recommended, rules, use_for, guide) wherever they disagree.";

const HOW_TO_CALL =
  "Call loremax_generate with {tool, arguments}: arguments exactly as schema names them (the plugin adds schema_revision and on_behalf_of; never send api_key). File arguments (file_args) take workspace paths — artifacts/… or files in your workdir — and the plugin uploads them; an array file argument takes a list of paths. Conditional rules (fields required, hidden or bounded depending on other fields) live in the schema's x-loremax-conditions; limits caps the media count and total size. A refused call (schema or argument error) is not charged; every accepted call is PAID.";
const HOW_TO_CALL_SHORT =
  "loremax_generate {tool, arguments}: file arguments take workspace paths (artifacts/… or workdir files); conditional rules live in x-loremax-conditions.";

/**
 * loremax_workflows' profile detail, with the guide's entry for the tool when there
 * is one. The schema is never cut (LoreMax publishes schemas up to 64 KB): over
 * REPLY_CAP the guide goes first, then the prose around the schema shrinks, and if
 * that is not enough the cap for this reply grows to the schema's size plus 2 KB.
 */
function profileDetails(t, guide) {
  const entry = guideEntry(guide, t.identity);
  const out = (description, how_to_call, withGuide) =>
    JSON.stringify({
      tool: t.name,
      title: t.title,
      description,
      ...(withGuide && entry ? { guide: { use_for: entry.use_for, knobs: entry.knobs, caveats: entry.caveats } } : {}),
      schema: t.agentSchema,
      file_args: t.fileArgs,
      limits: t.limits,
      how_to_call,
    }, null, 1);
  let s = out(t.description, HOW_TO_CALL, true);
  if (s.length <= REPLY_CAP) return s;
  if (entry) {
    s = out(t.description, HOW_TO_CALL, false);
    if (s.length <= REPLY_CAP) return s;
  }
  s = out(t.description.length > 300 ? `${t.description.slice(0, 300)}…` : t.description, HOW_TO_CALL_SHORT, false);
  // the schema as it is indented inside the reply; everything before it is short, so the tail is what a cut can reach
  const n = Math.max(REPLY_CAP, JSON.stringify({ schema: t.agentSchema }, null, 1).length + 2048);
  return s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s;
}

/** A workflow's key in the guide: its visual id, else `id:<numeric id>`; null without either. */
export function guideKey({ visualId, workflowId } = {}) {
  const v = typeof visualId === "string" ? visualId.trim() : "";
  if (v) return v;
  const n = typeof workflowId === "string" && /^\d+$/.test(workflowId.trim()) ? Number(workflowId) : workflowId;
  return Number.isSafeInteger(n) && n >= 0 ? `id:${n}` : null;
}

/** Every key a workflow may be filed under, in lookup order: visual id, then `id:<n>`. */
const guideKeys = ({ visualId, workflowId } = {}) => [guideKey({ visualId }), guideKey({ workflowId })].filter(Boolean);

/** The guide's entry for a workflow `{ visualId, workflowId }`: by visual id, then by `id:<n>`; null when none. */
export function guideEntry(guide, identity) {
  const entries = isObj(guide?.workflows) ? guide.workflows : {};
  // own keys only: a visual id such as "constructor" must not find Object.prototype's
  const k = guideKeys(identity).find((k) => Object.hasOwn(entries, k) && isObj(entries[k]));
  return k ? entries[k] : null;
}

/**
 * The guide's routes over the live catalog: `items` are `{ visualId, workflowId,
 * title, category, … }` (a REST workflow or a profile tool's identity) and come
 * back as they are, in each route's `pick` order (an item bound under two picked
 * keys counts once). A pick the catalog lacks is skipped, a route left with no
 * pick is dropped. `query` keeps a route whose task matches it whole, and from the
 * others only the items whose title, visual id, category or (profile) tool name match.
 * → [{ task, picks: [{ item, entry }] }]
 */
export function recommendedFrom(guide, items, query) {
  const byKey = new Map();
  for (const item of items ?? []) for (const k of guideKeys(item)) byKey.set(k, [...(byKey.get(k) ?? []), item]);
  const q = String(query ?? "").trim().toLowerCase();
  const matches = (v) => String(v ?? "").toLowerCase().includes(q);
  const out = [];
  for (const r of Array.isArray(guide?.routes) ? guide.routes : []) {
    if (!isObj(r) || typeof r.task !== "string" || !Array.isArray(r.pick)) continue;
    const wholeRoute = !q || matches(r.task);
    const picks = [];
    for (const k of r.pick) {
      for (const item of byKey.get(k) ?? []) {
        if (picks.some((p) => p.item === item)) continue;
        if (!wholeRoute && ![item.title, item.visualId, item.category, item.tool].some(matches)) continue;
        picks.push({ item, entry: guideEntry(guide, item) });
      }
    }
    if (picks.length) out.push({ task: r.task, picks });
  }
  return out;
}

/**
 * Who a profile generation is for, as LoreMax records it: `bridex:<workspace>:<agent>`
 * in the characters LoreMax allows, at most 128.
 */
const onBehalfOf = (call) => `bridex:${call.workspace ?? ""}:${call.agent ?? ""}`.replace(/[^A-Za-z0-9._:@ -]/g, "").trim().slice(0, 128).trim();

/** A profile job's params (kept on its row) → the provenance params: the agent's arguments plus tool and profile. */
const profileInputs = (p) => ({ ...(isObj(p.arguments) ? p.arguments : {}), tool: p.tool, ...(p.profile ? { profile: p.profile } : {}) });

/**
 * A profile tool's reply → the outputs to save, or null when there is nothing
 * in hand yet (pending, or a pipeline whose final read failed): that one is polled.
 */
function replyOutputs(sub) {
  if (sub?.status !== "completed") return null;
  let urls = urlsOf(sub);
  // a single-output reply may name only result_url
  if (!urls.length && typeof sub.result_url === "string" && sub.result_url) urls = [sub.result_url];
  const textContent = textOf(sub);
  if (!urls.length && !textContent) return null;
  return { originalUrls: urls, previewUrls: [], externalUrls: [], contentTypes: Array.isArray(sub.contentTypes) ? sub.contentTypes : [], textContent };
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

/** A Text workflow's output: `textContent` on a /check result or a v2 reply, `text_content` on an MCP one. */
function textOf(r) {
  const t = r?.textContent ?? r?.text_content;
  return typeof t === "string" && t.trim() ? t : "";
}
const urlsOf = (r) => [r?.originalUrls, r?.previewUrls, r?.externalUrls].find((u) => u?.length) ?? [];

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
   * Download outputs (and write a Text workflow's text as .md) into
   * artifacts/<task|loremax>/ with provenance. Returns the saved relative paths
   * and the URLs left on the CDN (download failed or over the cap), so the agent
   * still learns where those outputs are.
   */
  async function saveOutputs(call, workflowSlug, generationId, result, note, generation) {
    // a workflow can return its media only as externalUrls (outputs.external): LoreMax counts that as a success too
    const urls = urlsOf(result);
    const text = textOf(result);
    const rels = [];
    const skipped = [];
    if (!urls.length && !text) return { artifacts: rels, skipped };
    const folder = call.taskId ?? "loremax";
    const id = slugOf(generationId);
    const skip = (url, why) => {
      ctx.log.warn(`loremax output ${why}: ${url}`);
      skipped.push(url);
    };
    const overCap = `exceeds the ${Math.round(downloadCap / 1e6)}MB cap, left on the CDN`;
    const artRoot = ctx.paths.workspaceArtifacts(call.workspace);

    /** One output written to artifacts/<folder>/<name> with provenance; `fail(why)` hears a local save error. */
    function store(name, buf, fail) {
      const rel = path.posix.join(folder, name);
      const abs = path.join(artRoot, rel);
      const tmp = `${abs}.${process.pid}-${Date.now()}.part`;
      // a full disk or a read-only folder must not lose a paid result: that output
      // is reported, and the spend is still recorded by finish
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // the name is predictable: a symlinked folder or file planted there must not
        // redirect the write outside the workspace — check the folder, then write a
        // fresh temp file and rename it over whatever entry sits at the name
        const realRoot = fs.realpathSync(artRoot);
        const realDir = fs.realpathSync(path.dirname(abs));
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
          fail(`not saved: artifacts/${folder} leads outside the workspace`);
          return;
        }
        fs.writeFileSync(tmp, buf, { flag: "wx" });
        fs.renameSync(tmp, abs);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        fail(`not saved (${e?.code ?? e?.message ?? e})`);
        return;
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
      store(`${workflowSlug}-${id}${urls.length > 1 ? `-${i + 1}` : ""}.${ext}`, buf, (why) => skip(url, `${why}, left on the CDN`));
    }
    // the text came in the reply: nothing stays on a CDN if it cannot be written, so finish must not settle without it
    let textError = "";
    if (text)
      store(`${workflowSlug}-${id}.md`, Buffer.from(text, "utf8"), (why) => {
        ctx.log.warn(`loremax text output ${why}`);
        textError = why;
      });
    if (rels.length) ctx.artifacts.mirror(call.workspace, rels);
    return { artifacts: rels, skipped, ...(textError ? { textError } : {}) };
  }

  /**
   * A completed generation with neither URLs nor text (a Text workflow on the v2
   * execute reply, or on a LoreMax whose REST /check lacks textContent): for a
   * synchronous reply one REST /check for what it made, and only when that body has
   * no result at all (or the result already came from /check), one MCP
   * check_generation. Both are quick reads, kept short: this can run inside a
   * tool call. Never throws: the spend is still recorded.
   */
  async function lookupOutputs(generationId, { checked = false } = {}) {
    if (!checked) {
      try {
        const c = await lmx.check(generationId, { timeoutMs: LOOKUP_TIMEOUT_MS });
        if (c?.result) return c.result;
      } catch (e) {
        ctx.log.warn(`loremax check ${generationId} for its outputs: ${e?.message ?? e}`);
      }
    }
    try {
      const g = await lmx.mcpCall("check_generation", { generationId: String(generationId) }, { timeoutMs: LOOKUP_TIMEOUT_MS });
      const text = textOf(g);
      return text ? { textContent: text } : null;
    } catch (e) {
      ctx.log.warn(`loremax check_generation ${generationId}: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * A completed generation → files saved, spend recorded, job settled, tool reply.
   * job: { generationId, workflow, inputs?, references?, tokensCost?, trackedId?, note? }
   * check: LoreMax's /check reply with `result`, or `{ result, fromReply: true }`
   * for the outputs of a synchronous execute reply.
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
    let result = check?.result ?? {};
    if (!urlsOf(result).length && !textOf(result)) result = (await lookupOutputs(job.generationId, { checked: !check?.fromReply })) ?? result;
    const { artifacts, skipped, textError } = await saveOutputs(call, slugOf(workflow), job.generationId, result, job.note ?? "", generation);
    ctx.usage.record({
      workspace: call.workspace,
      agent: call.agent,
      kind: "loremax",
      model: workflow,
      costUsd,
      units: tokensCost,
      unit: "tk",
      taskId: call.taskId,
      // the host counts one spend per ref: a finish repeated after a crash is not billed twice
      ref: String(job.generationId),
    });
    // the job stays unsettled: the watcher (or the next loremax_result) writes the text again
    if (textError) throw new Error(`LoreMax generation ${job.generationId} finished, but its text output was ${textError} — poll loremax_result with this generation_id once the workspace is writable`);
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

/** The canonical MIME of a profile upload by (mediaType, ext): request_upload_url refuses one of another family. */
const MIME_BY_MEDIA = {
  image: Object.fromEntries(Object.entries(MIME_BY_EXT).filter(([, m]) => m.startsWith("image/"))),
  video: { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", ts: "video/mp2t", m4v: "video/x-m4v" },
  audio: { mp4: "audio/mp4", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", flac: "audio/flac" },
  model: { glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", stl: "model/stl", usdz: "model/vnd.usdz+zip", fbx: "model/fbx" },
};
/** LoreMax's upload cap (MiB), whatever a slot allows. */
const UPLOAD_CAP = 50 * 1024 * 1024;
const MIB = 1024 * 1024;
/** request_upload_url messages per POST (LoreMax batches ≤ 50); finalize_upload probes each object (~10 s), so its POSTs stay small. */
const UPLOAD_BATCH = 50;
const FINALIZE_FILES = 5;
const FINALIZE_BYTES = 100 * MIB;
const PUT_TIMEOUT_MS = 120_000;
const PUT_CONCURRENCY = 4;
/** Finalized URLs are reused for this long: a retried generation does not upload the same bytes again. */
const UPLOAD_CACHE_TTL_MS = 3_600_000;
const UPLOAD_CACHE_MAX = 2_000;

/** Bytes for a reply: MiB once it is that big. */
const sizeOf = (n) => (n >= MIB ? `${(n / MIB).toFixed(1)} MiB` : `${n} bytes`);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function sha256File(abs) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(abs)) h.update(chunk);
  return h.digest("hex");
}

/** Object keys sorted at every level, arrays as given: equal requests give equal JSON. */
const canonical = (v) =>
  Array.isArray(v) ? v.map(canonical) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;

/**
 * What a paid request asks for, where it goes and who gets its result → its key:
 * the same mode, workflow (or profile tool), arguments, reference bytes (in order:
 * they are sent in order), destination — base URL, profile path and API key (by
 * its hash): another server, organization or profile is another generation — and
 * caller — workspace, agent, session and task, where its wake and outputs go —
 * make the same generation.
 */
const submitKey = ({ mode, workflow, args, refs, target, call }) =>
  sha256(JSON.stringify(canonical({
    mode, workflow, args, refs, target,
    workspace: call.workspace, agent: call.agent ?? null, sessionKey: call.sessionKey ?? null, taskId: call.taskId ?? null,
  })));

/** fn over items, at most `limit` at a time; the first failure rejects. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Workspace files for a profile tool's file arguments: checked against the
 * tool's x-loremax-media and x-loremax-limits before any HTTP, then uploaded
 * (request_upload_url → PUT → finalize_upload) and swapped for their finalized
 * URLs. `cache` (sha256(key) + mediaType + sha256(file) → url) is process-wide.
 */
export function createUploader(ctx, lmx, outputs, { now = Date.now, cache = (globalThis[Symbol.for("bridex.loremax.uploads")] ??= new Map()) } = {}) {
  /** A refused or failed upload: the generation was never sent. */
  const refused = (e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!/nothing was charged/.test(err.message)) err.message = `${err.message} — nothing was charged`;
    err.charged = false;
    return err;
  };
  /** A reply that never arrived (timeout, dropped connection, gateway 5xx, missing batch message): the chunk is worth one more try. */
  const lost = (e) => !e?.deadline && (e?.lost || e?.name === "TimeoutError" || e?.name === "AbortError" || e instanceof TypeError || e?.status >= 500);

  function cacheGet(k) {
    const hit = cache.get(k);
    if (hit && now() - hit.at < UPLOAD_CACHE_TTL_MS) return hit.url;
    if (hit) cache.delete(k);
    return null;
  }
  function cacheSet(k, url) {
    cache.delete(k);
    cache.set(k, { url, at: now() });
    // oldest first: a Map keeps insertion order
    while (cache.size > UPLOAD_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** One batch of tool calls on the profile path → each call's data, in order. */
  async function batch(name, argsList, opts) {
    const path = lmx.profilePath();
    const msgs = argsList.map((a) => ({ jsonrpc: "2.0", id: lmx.nextId(), method: "tools/call", params: { name, arguments: a } }));
    const replies = await lmx.rpc(path, msgs, opts);
    return msgs.map((m) => {
      const r = replies.get(m.id);
      if (!r) throw Object.assign(new Error(`loremax ${name}: no reply to this call`), { lost: true });
      return lmx.toolResult(name, r);
    });
  }

  /** request_upload_url and PUT for each item → item.assetId. */
  async function stage(items, deadline) {
    for (let i = 0; i < items.length; i += UPLOAD_BATCH) {
      const part = items.slice(i, i + UPLOAD_BATCH);
      // the upload tools are strict: no on_behalf_of, no api_key
      const tickets = await batch("request_upload_url", part.map((it) => ({ filename: it.filename, mime: it.mime, media_type: it.mediaType, size_hint: it.size })), { timeoutMs: LOOKUP_TIMEOUT_MS, deadline });
      tickets.forEach((t, j) => {
        if (typeof t?.asset_id !== "string" || typeof t?.upload_url !== "string") throw new Error(`loremax request_upload_url for ${part[j].shown}: no asset_id/upload_url in the reply`);
        part[j].ticket = t;
      });
    }
    await mapLimit(items, PUT_CONCURRENCY, async (it) => {
      const left = deadline == null ? Infinity : deadline - now();
      if (left <= 0) throw deadlineError(`upload of ${it.shown}`);
      const buf = fs.readFileSync(it.abs);
      // the cache key is the hash taken before the tickets: other bytes must not be cached under it
      if (buf.length !== it.size || sha256(buf) !== it.sha) throw new Error(`${it.shown} changed while it was being uploaded`);
      let res;
      try {
        // exactly the signed headers: Content-Type and Content-Length are bound to the ticket
        res = await fetch(it.ticket.upload_url, { method: "PUT", headers: { ...(isObj(it.ticket.headers) ? it.ticket.headers : {}) }, body: buf, signal: AbortSignal.timeout(Math.min(PUT_TIMEOUT_MS, left)) });
        await res.body?.cancel();
      } catch (e) {
        if (left < PUT_TIMEOUT_MS && e?.name === "TimeoutError") throw deadlineError(`upload of ${it.shown}`);
        throw e;
      }
      if (!res.ok) throw httpError(`loremax upload of ${it.shown} failed (HTTP ${res.status})`, res.status, "");
      it.assetId = it.ticket.asset_id;
    });
  }

  /** finalize_upload for one chunk → item.url; the server reads and probes every object, so the timeout grows with the chunk. */
  async function finalize(chunk, deadline) {
    const bytes = chunk.reduce((n, it) => n + it.size, 0);
    const timeoutMs = 15_000 + 10_000 * chunk.length + Math.ceil(bytes / (10 * MIB)) * 1000;
    const done = await batch("finalize_upload", chunk.map((it) => ({ asset_id: it.assetId })), { timeoutMs, deadline });
    done.forEach((f, j) => {
      if (typeof f?.url !== "string" || !/^https:\/\//.test(f.url)) throw new Error(`loremax finalize_upload for ${chunk[j].shown}: no url in the reply`);
      chunk[j].url = f.url;
    });
  }

  /** Items → finalize chunks of ≤ FINALIZE_FILES files and ≤ FINALIZE_BYTES (one file always fits). */
  function chunksOf(items) {
    const out = [];
    let cur = [];
    let bytes = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= FINALIZE_FILES || bytes + it.size > FINALIZE_BYTES)) {
        out.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(it);
      bytes += it.size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /**
   * The tool's file arguments in `args` (a workspace path, or a list of them for
   * an array slot) → `{ arguments, references }`: the arguments with each path
   * replaced by its finalized URL in place, and the workspace paths in order. An
   * https:// value passes through (LoreMax accepts only its own finalized URLs).
   * Everything is checked before the first request; any failure throws with
   * `charged: false` — the generation was never sent.
   */
  async function uploadFiles(call, tool, args, { deadline } = {}) {
    try {
      const out = { ...(args ?? {}) };
      const references = [];
      /** Every position, in argument order: a local file or a URL passed through. */
      const positions = [];
      /** The file arguments given, to put the URLs back in their places. */
      const slots = [];
      for (const fa of tool.fileArgs ?? []) {
        let v = out[fa.name];
        if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
        const where = `${tool.name}.${fa.name}`;
        if (fa.cardinality === "array") {
          // one path for a list slot is a list of one
          if (!Array.isArray(v)) v = [v];
          const prop = tool.agentSchema?.properties?.[fa.name] ?? {};
          if (Number.isFinite(prop.maxItems) && v.length > prop.maxItems) throw new Error(`${where} takes at most ${prop.maxItems} files, got ${v.length}`);
          if (Number.isFinite(prop.minItems) && v.length < prop.minItems) throw new Error(`${where} takes at least ${prop.minItems} files, got ${v.length}`);
        } else if (Array.isArray(v)) {
          throw new Error(`${where} takes one file path, not a list of ${v.length}`);
        }
        const list = Array.isArray(v) ? v : [v];
        const formats = (fa.acceptedFormats ?? []).map((f) => String(f).toLowerCase());
        const maxMb = Number(fa.constraints?.maxFileSizeMb);
        const cap = Math.min(UPLOAD_CAP, Number.isFinite(maxMb) && maxMb > 0 ? maxMb * MIB : Infinity);
        const slot = list.map((p) => {
          if (typeof p !== "string" || !p.trim()) throw new Error(`${where} takes workspace paths, got ${JSON.stringify(p)?.slice(0, 100)}`);
          const pos = { fa, value: p };
          positions.push(pos);
          if (/^https:\/\//i.test(p)) return pos;
          if (/^[a-z][a-z0-9+.-]*:/i.test(p)) throw new Error(`${where}: "${p.slice(0, 200)}" is neither a workspace path nor a finalized LoreMax https URL`);
          const abs = outputs.resolveLocal(call.workspace, p);
          const ext = path.extname(abs).slice(1).toLowerCase();
          if (formats.length && !formats.includes(ext)) throw new Error(`${where}: ${p} is .${ext || "(none)"}; this argument accepts ${formats.join(", ")}`);
          const mime = MIME_BY_MEDIA[fa.mediaType]?.[ext];
          if (!mime) throw new Error(`${where}: ${p} — .${ext || "(none)"} is not a supported ${fa.mediaType} format`);
          const size = fs.statSync(abs).size;
          if (size > cap) throw new Error(`${where}: ${p} is ${sizeOf(size)}; this argument takes up to ${sizeOf(cap)} per file`);
          Object.assign(pos, { abs, ext, mime, size });
          references.push(p);
          return pos;
        });
        slots.push({ name: fa.name, list: Array.isArray(v), slot });
      }
      if (!positions.length) return { arguments: out, references };

      // identical bytes are one upload (and count once against the byte budget, as on the server)
      const shaByAbs = new Map();
      for (const pos of positions) {
        if (!pos.abs) continue;
        if (!shaByAbs.has(pos.abs)) shaByAbs.set(pos.abs, await sha256File(pos.abs));
        pos.sha = shaByAbs.get(pos.abs);
      }
      const lim = tool.limits ?? {};
      const images = positions.filter((p) => p.fa.mediaType === "image" && p.fa.role !== "mask").length;
      const uniqueBytes = [...new Map(positions.filter((p) => p.sha).map((p) => [p.sha, p.size])).values()].reduce((a, b) => a + b, 0);
      if (Number.isFinite(lim.maxImagePositions) && images > lim.maxImagePositions) throw new Error(`${tool.name}: ${images} images (masks aside); this tool takes at most ${lim.maxImagePositions} per call`);
      if (Number.isFinite(lim.maxMediaPositions) && positions.length > lim.maxMediaPositions) throw new Error(`${tool.name}: ${positions.length} files; this tool takes at most ${lim.maxMediaPositions} per call`);
      if (Number.isFinite(lim.maxTotalBytes) && uniqueBytes > lim.maxTotalBytes) throw new Error(`${tool.name}: the files add up to ${sizeOf(uniqueBytes)}; this tool takes at most ${sizeOf(lim.maxTotalBytes)} per call`);

      const keyHash = sha256(lmx.key());
      const items = new Map();
      for (const pos of positions) {
        if (!pos.abs) continue;
        const k = `${keyHash}:${pos.fa.mediaType}:${pos.sha}`;
        pos.url = cacheGet(k);
        if (pos.url) continue;
        if (!items.has(k)) items.set(k, { key: k, sha: pos.sha, abs: pos.abs, shown: pos.value, filename: path.basename(pos.abs), mime: pos.mime, mediaType: pos.fa.mediaType, size: pos.size, positions: [] });
        items.get(k).positions.push(pos);
      }
      const todo = [...items.values()];
      if (todo.length) {
        await stage(todo, deadline);
        for (const chunk of chunksOf(todo)) {
          try {
            await finalize(chunk, deadline);
          } catch (e) {
            if (!lost(e)) throw e;
            // the finalize reply was lost: the same bytes again (LoreMax dedupes to the same asset), this chunk only
            ctx.log.warn(`loremax finalize_upload lost (${e?.message ?? e}) — uploading ${chunk.length} file(s) again`);
            await stage(chunk, deadline);
            await finalize(chunk, deadline);
          }
          for (const it of chunk) {
            cacheSet(it.key, it.url);
            for (const pos of it.positions) pos.url = it.url;
          }
        }
      }
      for (const { name, list, slot } of slots) {
        const urls = slot.map((pos) => pos.url ?? pos.value);
        out[name] = list ? urls : urls[0];
      }
      return { arguments: out, references };
    } catch (e) {
      throw refused(e);
    }
  }

  return { uploadFiles };
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

/** `opts` is for tests only (the host passes just ctx): poll interval, clock, sleep and a guide replacing the shipped GUIDE. */
export default async function activate(ctx, { pollMs = POLL_MS, now = Date.now, sleep = realSleep, guide = GUIDE } = {}) {
  const lmx = createClient(ctx, { now, sleep });
  const outputs = createOutputs(ctx, lmx);
  /**
   * What finish needs beyond the job row, by LoreMax generation id. Lost on a
   * restart: then rebuilt from the row's track() params, or on older cores from
   * job.model and job.label only. A re-activation takes the previous instance's
   * map over, with or without a shutdown in between (see the watcher start): a
   * synchronous result older cores keep nowhere else must not be lost.
   */
  const generations = globalThis[WATCHER_SLOT]?.generations ?? new Map();
  /** The job a generation id stands for after a restart: from the row's params, else its label. */
  const fromRow = (generationId, row, found) => {
    const p = found?.result?.params;
    return {
      generationId,
      workflow: row?.model ?? "",
      // a submission placeholder's params describe no generation
      ...(p && typeof p === "object" && !p.submitting
        ? {
          inputs: p.mode === "profile" ? profileInputs(p) : p.inputs ?? {},
          references: p.references ?? [],
          tokensCost: Number(p.tokensCost) || 0,
          note: p.note ?? "",
          ...(p.syncResult ? { syncResult: p.syncResult } : {}),
        }
        : fromJobLabel(row?.label)),
    };
  };
  /**
   * One status read of a tracked generation. A synchronous one is never sent to
   * /check (the deployed REST check may still answer 400 for it): its row keeps
   * the execute reply's outputs, and those are what a retried save uses.
   */
  const statusOf = (job, opts) =>
    job.syncResult ? { status: "completed", result: job.syncResult, fromReply: true } : lmx.check(job.generationId, opts);
  /**
   * Generation ids a tool call or the watcher is polling right now: the others
   * leave them alone so one generation is never downloaded and settled twice.
   * Process-wide, not per activation: an update or dashboard toggle re-activates
   * (re-imports) the plugin while the old instance's tool calls are still polling.
   */
  const inFlight = (globalThis[Symbol.for("bridex.loremax.inFlight")] ??= new Set());
  /**
   * Submissions on their way to LoreMax, by submitKey → the submission's id: an
   * identical call meanwhile is refused instead of paying for the same generation
   * twice. Process-wide for the same reason as inFlight.
   */
  const submitting = (globalThis[Symbol.for("bridex.loremax.submitting")] ??= new Map());
  /** Where a submission goes, for submitKey; a setting that is missing or invalid reads as null (the call then fails on it). */
  const submitTarget = () => {
    const read = (f) => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    const k = read(lmx.key);
    return { base: read(lmx.baseUrl), profile: read(lmx.profilePath), auth: k ? sha256(k) : null };
  };
  // tools still register without a key: each call surfaces the Settings hint,
  // and setting the credential needs no restart
  if (!lmx.hasKey()) ctx.needsConfig("Add the LoreMax API key (Settings → Integrations, LOREMAX_API_KEY).");
  // an http:// base_url (fine before 0.2.1) refuses every call: say so now, not only in the health check
  let badBase = null;
  try {
    lmx.baseUrl();
  } catch (e) {
    badBase = e;
    ctx.needsConfig(e.message);
  }
  /**
   * The mode, decided once: profile_url set → profile mode (the profile's curated
   * catalog), else REST mode (every workflow of the organization). An invalid
   * profile_url is still profile mode — falling back to REST would hand the agent
   * the whole catalog without the profile's preflight — and every tool throws the
   * config error before any HTTP.
   */
  let profile = null;
  try {
    const p = lmx.profilePath();
    if (p) profile = { path: p };
  } catch (e) {
    profile = { error: e };
    // a full profile_url reads base_url too: its error is already reported
    if (e.message !== badBase?.message) ctx.needsConfig(e.message);
  }
  ctx.log.info(
    profile?.error ? `loremax mode: profile (invalid profile_url — tools refuse until it is fixed)`
      : profile ? `loremax mode: profile ${profile.path}`
        : "loremax mode: REST (all workflows of the organization)",
  );

  const { z } = ctx;
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const cap = (s, n = REPLY_CAP) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  const short = (s, n = 200) => String(s ?? "").slice(0, n);

  /**
   * Profile mode has its own loremax_workflows / loremax_generate (registered in
   * place of the REST ones); loremax_result is shared, since both modes poll the
   * same REST check. An invalid profile_url swaps every handler for the config error.
   */
  const profileTools = new Map();
  const registerTool = (def) => {
    const d = (profile && profileTools.get(def.name)) || def;
    ctx.registerTool(profile?.error ? { ...d, handler: async () => { throw profile.error; } } : d);
  };
  /** The profile's tools/list, shared by every profile-mode tool (null in REST mode or with an invalid profile_url). */
  const catalog = profile?.path ? createProfileCatalog(lmx, { now, log: ctx.log }) : null;
  /** The studio's own profile instructions, read only by the list view. */
  const instructions = profile?.path ? createProfileInstructions(lmx, { now, log: ctx.log }) : null;
  const uploader = profile?.path ? createUploader(ctx, lmx, outputs, { now }) : null;
  if (profile) {
    profileTools.set("loremax_workflows", {
      name: "loremax_workflows",
      description:
        "LoreMax workflows curated for this studio's profile (free). Without tool: the studio's instructions, the recommended tools per task and the list (tool, title, category, required arguments, file arguments), optionally filtered by query; the studio's instructions and a tool's own description take precedence over the generic guide. With tool: that workflow's exact argument schema (JSON Schema), its file arguments and limits — ALWAYS read it before a paid loremax_generate. No price is shown: every loremax_generate call is charged in LoreMax tokens.",
      schema: {
        tool: z.string().optional().describe("tool name from the list; returns its argument schema"),
        query: z.string().optional().describe("case-insensitive filter over tool, title, category and visual id"),
      },
      handler: async (args) => {
        const deadline = now() + MAX_WAIT_S * 1000;
        const name = String(args.tool ?? "").trim();
        if (!name) {
          // a dead profile is reported by the catalog read; the instructions never throw
          const [c, ins] = await Promise.all([catalog.get({ deadline }), instructions.get({ deadline })]);
          return text(cap(JSON.stringify(profileList(c, args.query, { guide, instructions: ins }), null, 1)));
        }
        let c = await catalog.get({ deadline });
        let t = c.tools.get(name);
        // a tool added to the profile since the last read: one fresh tools/list before giving up
        if (!t) {
          c = await catalog.get({ force: true, deadline });
          t = c.tools.get(name);
        }
        if (!t) {
          const names = [...c.tools.keys()];
          throw new Error(`loremax_workflows: no such tool "${short(name, 100)}" in this profile — tools: ${names.length ? names.join(", ") : "(none)"}`);
        }
        return text(profileDetails(t, guide));
      },
    });
    profileTools.set("loremax_generate", {
      name: "loremax_generate",
      description:
        `Run a curated LoreMax workflow. PAID per call: read the tool's schema with loremax_workflows first and pass arguments exactly as it names them. File arguments take workspace paths (artifacts/… or workdir files); the plugin uploads them. Outputs are saved into this task's artifacts with provenance. A refused call (status rejected: bad arguments, changed schema, unavailable tool) is not charged — fix and call again. Waits at most ${MAX_WAIT_S}s: if the wait runs out you get status in_progress (with a generation_id) or submitting back and are WOKEN when it lands. Never call it again for a submitting reply.`,
      schema: {
        tool: z.string().describe("tool name from loremax_workflows"),
        arguments: z.record(z.string(), z.unknown()).describe("arguments exactly as the tool's schema names them"),
        wait_s: z.number().int().min(10).max(MAX_WAIT_S).optional().describe(`seconds to wait before handing back (10..${MAX_WAIT_S})`),
        note: z.string().max(200).optional().describe("short provenance note stored on the outputs (what this is for)"),
      },
      handler: async (args, call) => {
        // the budget covers the whole call from here: catalog, uploads, submission, polling and saving
        const start = now();
        const waitS = waitSeconds(args.wait_s, 10, lmx.defaultWaitS());
        const until = start + waitS * 1000;
        const deadline = start + MAX_WAIT_S * 1000;
        const name = String(args.tool ?? "").trim();
        if (!name) throw new Error("tool is required — pick one from loremax_workflows");
        if (args.arguments != null && !isObj(args.arguments)) throw new Error("arguments must be an object, named exactly as the tool's schema from loremax_workflows");
        const agentArgs = { ...(args.arguments ?? {}) };
        // the plugin fills these in itself (an api_key would also bypass the configured key)
        for (const k of INJECTED_ARGS) delete agentArgs[k];
        const note = String(args.note ?? (typeof agentArgs.prompt === "string" ? agentArgs.prompt.slice(0, 120) : ""));
        const base = { args: agentArgs, note };
        // canonical: the same arguments in another key order name their files in the same order
        const key = submitKey({ mode: "profile", workflow: name, args: agentArgs, refs: await argFileHashes(call.workspace, canonical(agentArgs)), target: submitTarget(), call });
        if (submitting.has(key)) return text(JSON.stringify(duplicateReply(key, { tool: name }), null, 1));

        // the whole sequence is the detached unit: a late answer (even a refused upload) still comes as a wake
        const ph = ctx.jobs && ctx.wakeAgent ? trackSubmit(call, { mode: "profile", tool: name, note, key }) : null;
        const submission = submitProfile(call, name, agentArgs, ph ? undefined : deadline).catch((error) => ({ error }));
        if (!ph) holdWhile(key, submission);
        const first = await raceBudget(ph, submission, until);
        if (!first) {
          submission
            .then((o) => settleLate(ph, o, (x) => acceptedProfile(call, x, base), (e) => profileLate(ph, e, name)))
            .catch((e) => ctx.log.warn(`loremax ${ph.submitId}: ${e?.message ?? e}`));
          return text(JSON.stringify({
            status: "submitting",
            tool: name,
            hint: "submitted, still waiting for LoreMax — do NOT call loremax_generate again; end your turn, you will be WOKEN with the result",
          }, null, 1));
        }
        let got;
        try {
          if (first.error) throw first.error;
          got = acceptedProfile(call, first, base);
        } catch (e) {
          if (ph) settleSubmit(ph, "failed", { error: e?.message ?? e });
          return text(JSON.stringify(await profileFailure(e, name, { deadline }), null, 1));
        }
        return text(JSON.stringify(await landed(call, ph, got, { until, deadline, waitS }), null, 1));
      },
    });
  }

  registerTool({
    name: "loremax_workflows",
    description:
      "LoreMax workflows of this organization (free). Without workflow_id: the list (id, visual_id, title, category), optionally filtered by query. With workflow_id: that workflow's input fields (keys, types, options) and its price in LoreMax tokens — ALWAYS read it before a paid loremax_generate: inputs are passed through exactly as these fields name them. Start from recommended, the best live workflow per task, and follow rules; cheap or draft workflows only when someone asked for cheap or draft.",
    schema: {
      workflow_id: z.string().optional().describe("numeric id or visual id from the list; returns input fields and price"),
      query: z.string().optional().describe("case-insensitive filter over title, description, visual id and category"),
    },
    handler: async (args) => {
      // under the client's 60 s like every tool call: requests and Retry-After waits end here
      const deadline = now() + MAX_WAIT_S * 1000;
      const id = String(args.workflow_id ?? "").trim();
      if (!id) {
        const r = await lmx.restJson("/api/v1/workflows", {}, { deadline });
        const q = String(args.query ?? "").trim().toLowerCase();
        const all = (r.workflows ?? []).map((w) => ({ id: w.id, visual_id: w.visualId, title: w.title, category: w.category, description: short(w.description) }));
        const workflows = all.filter((w) => !q || [w.title, w.description, w.visual_id, w.category].some((v) => String(v ?? "").toLowerCase().includes(q)));
        // routes over the organization's live workflows, before the list so cap() never cuts them
        const recommended = recommendedFrom(guide, all.map((w) => ({ ...w, visualId: w.visual_id, workflowId: w.id })), q).map((rt) => ({
          task: rt.task,
          workflows: rt.picks.map(({ item, entry }) => ({ id: item.id, visual_id: item.visual_id, title: item.title, why: entry?.use_for })),
        }));
        const rules = !q && Array.isArray(guide?.rules) && guide.rules.length ? guide.rules : undefined;
        return text(cap(JSON.stringify({
          ...(recommended.length ? { recommended } : {}),
          ...(rules ? { rules } : {}),
          workflows,
          hint: workflows.length || recommended.length
            ? "call loremax_workflows with workflow_id to read its input fields and price before loremax_generate"
            : q ? `no workflow matches "${args.query}" — call without query for the full list` : "this organization has no workflows",
        }, null, 1)));
      }
      // get_workflow_details takes visual_id but also finds a workflow by its numeric id
      const d = (await lmx.mcpCall("get_workflow_details", { visual_id: id }, { deadline })) ?? {};
      const out = {
        workflow: { id: d.id ?? id, visual_id: d.visual_id, title: d.title, category: d.category, description: d.description },
        input_fields: d.input_fields ?? [],
        usage_hint: d.usage_hint,
        ...(d.pricing_variables_required ? { pricing_variables_required: d.pricing_variables_required } : {}),
      };
      // the agent may name the workflow either way; LoreMax's answer fills in the other
      const numeric = /^\d+$/.test(id);
      const entry = guideEntry(guide, { visualId: d.visual_id ?? (numeric ? undefined : id), workflowId: d.id ?? (numeric ? id : undefined) });
      if (entry) out.guide = { use_for: entry.use_for, knobs: entry.knobs, caveats: entry.caveats };
      // the price is a courtesy: a pricing hiccup must not hide the fields the agent needs
      try {
        const p = await lmx.mcpCall("get_pricing", { workflowId: id }, { deadline });
        out.token_cost = p?.tokenCost;
      } catch (e) {
        out.price = `unavailable: ${short(e?.message ?? e)}`;
      }
      return text(cap(JSON.stringify(out, null, 1)));
    },
  });

  /** A generation tool of the profile by name; a name missing from the catalog gets one fresh tools/list first. */
  async function profileToolNamed(name, deadline) {
    let c = await catalog.get({ deadline });
    if (!c.tools.has(name)) c = await catalog.get({ force: true, deadline });
    const t = c.tools.get(name);
    if (!t) throw Object.assign(new Error(`loremax_generate: no such tool "${short(name, 100)}" in this profile`), { code: "TOOL_NOT_FOUND", charged: false, refreshed: true });
    return t;
  }

  /**
   * The profile sequence up to LoreMax's answer: the tool from the catalog, its
   * file arguments uploaded, then the paid call with schema_revision and
   * on_behalf_of → { sub, tool, references }. `deadline` (blocking cores only)
   * bounds what comes before the paid call, which then starts only with
   * PAID_CALL_RESERVE_MS left; a detached unit always gets its answer to the agent.
   */
  async function submitProfile(call, name, agentArgs, deadline) {
    let t;
    let up;
    try {
      t = await profileToolNamed(name, deadline);
      up = await uploader.uploadFiles(call, t, agentArgs, { deadline });
      if (deadline != null && deadline - now() < PAID_CALL_RESERVE_MS) throw deadlineError("loremax_generate");
    } catch (e) {
      if (e?.deadline)
        throw Object.assign(new Error("loremax_generate ran out of time before the paid call — nothing was charged; uploads are cached — call loremax_generate again"), { charged: false });
      // a catalog read that failed: the generation was never sent
      if (!e?.code && e?.charged !== false) Object.assign(e, { message: `${e?.message ?? e} — nothing was charged`, charged: false });
      throw e;
    }
    let sub;
    try {
      // the paid call is never cut short: aborting it would not stop LoreMax
      sub = await lmx.toolCall(profile.path, name, { ...up.arguments, schema_revision: t.revision, on_behalf_of: onBehalfOf(call) }, { timeoutMs: 600_000 });
    } catch (e) {
      const u = unanswered(e, name);
      // an answer that is no tool outcome (a JSON-RPC error, an unreadable result, a missing reply): it may have run
      if (u === e && e?.status == null && !e?.code && !e?.toolError)
        throw Object.assign(new Error(`${e?.message ?? e} — LoreMax may have accepted and charged this generation; check its generation history before running it again`), { ambiguous: true });
      throw u;
    }
    return { sub, tool: t, references: up.references };
  }

  /** A profile tool's reply → the job, plus the outputs when they came with it (null: poll the REST check). */
  function acceptedProfile(call, { sub, tool: t, references }, { args, note }) {
    if (sub?.status === "failed")
      throw Object.assign(new Error(`loremax ${t.name}: ${sub.error ?? "the generation failed"}`.slice(0, 500)), { code: "GENERATION_FAILED", toolError: true, details: { generationId: sub.generationId } });
    if (sub?.generationId == null) throw new Error(`loremax ${t.name} returned no generationId: ${JSON.stringify(sub).slice(0, 300)}`);
    const generationId = String(sub.generationId);
    const tokensCost = Number(sub.tokensCost) || 0;
    const workflow = String(t.identity.visualId ?? t.identity.title ?? t.name);
    ctx.log.info(`@${call.agent} loremax ${t.name} → generation ${generationId} (${tokensCost} tk)`);
    // the workspace paths, never the uploaded URLs: provenance points at the studio's own files
    const p = { mode: "profile", tool: t.name, arguments: args, profile: profile.path.split("/").pop() };
    const job = { generationId, workspace: call.workspace, workflow, ...p, inputs: profileInputs(p), references, tokensCost, note, identity: t.identity };
    return { job, result: replyOutputs(sub) };
  }

  /**
   * A profile call that did not produce a generation → the reply for the agent:
   * `rejected` (refused before any debit: fix and call again) or `failed`. A
   * config error, an unknown outcome (may have been charged) and a refused
   * upload are thrown as they are. The catalog is reread where the error says
   * it changed, so the reply carries the current schema or tool list.
   */
  async function profileFailure(e, name, { deadline } = {}) {
    const code = e?.code;
    const error = String(e?.message ?? e);
    let c;
    const current = async () => {
      if (c !== undefined) return c;
      if (!e?.refreshed) catalog.refreshAfter(e);
      try {
        c = await catalog.get({ deadline });
      } catch (x) {
        ctx.log.warn(`loremax ${profile.path} tools/list: ${x?.message ?? x}`);
        c = null;
      }
      return c;
    };
    if (code === "PROFILE_NOT_FOUND") throw Object.assign(e, { config: true });
    if (code === "PROFILE_ORGANIZATION_MISMATCH")
      throw Object.assign(new Error(`${error} — ${PROFILE_CAUSES}; ${PROFILE_HINT}`), { code, config: true, charged: false });
    if (code === "INVALID_WORKFLOW_INPUT" || code === "MEDIA_INPUT_INVALID") {
      const t = (await current())?.tools.get(name);
      const issues = Array.isArray(e.details?.issues) ? e.details.issues : null;
      return {
        status: "rejected",
        charged: false,
        error_code: code,
        error,
        ...(issues ? { issues } : {}),
        ...(t ? { schema: t.agentSchema } : {}),
        hint: "not charged — fix the arguments to match the schema, then call loremax_generate again",
      };
    }
    if (code === "SCHEMA_REVISION_MISMATCH") {
      const cur = await current();
      const t = cur?.tools.get(name);
      // no automatic retry: defaults, bounds or required fields may have changed under the agent's arguments
      if (t)
        return {
          status: "rejected",
          charged: false,
          error_code: code,
          error,
          schema: t.agentSchema,
          file_args: t.fileArgs,
          hint: "not charged — the tool's schema changed in LoreMax: check your arguments against this schema, then call loremax_generate again",
        };
      // the reread failed: the tool may well still be there
      if (!cur)
        return {
          status: "rejected",
          charged: false,
          error_code: code,
          error,
          hint: "not charged — the tool's schema changed in LoreMax: read it again with loremax_workflows, then call loremax_generate again",
        };
    }
    if (code === "SCHEMA_REVISION_MISMATCH" || code === "WORKFLOW_UNAVAILABLE" || code === "TOOL_NOT_FOUND") {
      const cur = await current();
      return {
        status: "rejected",
        charged: false,
        error_code: code,
        error,
        tools: cur ? [...cur.tools.keys()] : [],
        hint: "not charged — this tool is unavailable in the profile: pick one of tools and read its schema with loremax_workflows first",
      };
    }
    // an upload refused or a catalog read failed: the message says nothing was charged
    if (e?.charged === false) throw e;
    if (code === "INSUFFICIENT_TOKENS" || (e?.toolError && /insufficient tokens/i.test(error))) {
      const required = Number(e.details?.requiredTokens);
      return {
        status: "failed",
        charged: false,
        error_code: "INSUFFICIENT_TOKENS",
        error,
        ...(Number.isFinite(required) ? { required_tokens: required } : {}),
        hint: "the LoreMax balance is too low — a person has to top it up (they have been notified); do not retry until then",
      };
    }
    if (code === "GENERATION_FAILED" || e?.toolError) {
      const gid = e.details?.generationId;
      return {
        status: "failed",
        ...(code ? { error_code: code } : {}),
        error,
        ...(gid != null ? { generation_id: String(gid) } : {}),
        hint: "LoreMax refunds failed runs — check its generation history; do not retry blindly with the same arguments",
      };
    }
    throw e;
  }

  /** The wake line for a profile submission that ended without a generation after the tool call had replied. */
  async function profileLate(ph, e, name) {
    let r;
    try {
      r = await profileFailure(e, name);
    } catch (x) {
      return lateFailure(ph, x);
    }
    const issues = r.issues?.length ? ` — issues: ${JSON.stringify(r.issues).slice(0, 1500)}` : "";
    return r.status === "rejected"
      ? `${ph.what} was refused before it ran (not charged): ${r.error}${issues}. ${r.hint}${ph.task}.`
      : `${ph.what} FAILED: ${r.error}${r.generation_id ? ` (generation ${r.generation_id})` : ""}. ${r.hint}${ph.task}.`;
  }

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
      throw unanswered(e, "execute");
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
      : { originalUrls: sub.originalUrls ?? [], previewUrls: sub.previewUrls ?? [], externalUrls: sub.externalUrls ?? [], contentTypes: [], textContent: textOf(sub) };
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
        params: {
          ...(job.mode === "profile"
            ? { mode: "profile", tool: job.tool, arguments: job.arguments, references: job.references, tokensCost: job.tokensCost, note: job.note, identity: job.identity, profile: job.profile }
            : { inputs: job.inputs, references: job.references, tokensCost: job.tokensCost, note: job.note }),
          ...(job.syncResult ? { syncResult: job.syncResult } : {}),
        },
      })
      : null;
    generations.set(job.generationId, job);
  }

  /**
   * The placeholder row of a submission in progress: a restart while LoreMax
   * renders a slow request leaves it running, and the next watcher tells the agent.
   */
  function trackSubmit(call, { mode, workflow, tool, note, key }) {
    const submitId = `submit:${crypto.randomUUID()}`;
    const trackedId = ctx.jobs.track({
      workspace: call.workspace,
      agent: call.agent,
      taskId: call.taskId ?? null,
      sessionKey: call.sessionKey ?? null,
      runId: call.runId ?? null,
      externalId: submitId,
      model: workflow ?? tool,
      label: note,
      params: { submitting: true, mode, ...(tool != null ? { tool } : { workflow }), note },
    });
    inFlight.add(submitId);
    submitting.set(key, submitId);
    return { submitId, key, trackedId, call, what: `LoreMax ${workflow ?? tool}${note ? ` (${note})` : ""}`, task: call.taskId ? ` (task ${call.taskId})` : "" };
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
      releaseSubmit(ph.key, ph.submitId);
    }
  }

  /** Frees `key` — only while it is still this submission's. */
  const releaseSubmit = (key, id) => {
    if (submitting.get(key) === id) submitting.delete(key);
  };

  /** A core without job rows has no placeholder to settle: `key` is held until `submission` settles. */
  function holdWhile(key, submission) {
    const id = `submit:${crypto.randomUUID()}`;
    submitting.set(key, id);
    const release = () => releaseSubmit(key, id);
    submission.then(release, release);
  }

  /** The reply to a request identical to one still being submitted: nothing is sent, nothing is charged. */
  const duplicateReply = (key, what) => ({
    status: "submitting",
    duplicate_of: submitting.get(key),
    ...what,
    hint: ctx.jobs && ctx.wakeAgent
      ? "this exact request is already being submitted — do NOT call loremax_generate again; end your turn, you will be WOKEN with the result"
      : "this exact request is already being submitted — do NOT call loremax_generate again; the call that sent it returns the result",
  });

  /**
   * sha256 of every workspace file a profile call's arguments name. Which
   * arguments are files is known only after the catalog read, so every string
   * that resolves to a workspace file counts (URLs and other text resolve to none).
   * A file over the upload cap is refused by the upload step anyway: its size and
   * mtime stand in for a read of the whole file. An unreadable one counts as none
   * (the upload step reports it).
   */
  async function argFileHashes(ws, v, out = []) {
    if (typeof v === "string") {
      if (v.trim() && !/^[a-z][a-z0-9+.-]*:/i.test(v)) {
        try {
          const abs = outputs.resolveLocal(ws, v);
          const st = fs.statSync(abs);
          out.push(st.size > UPLOAD_CAP ? `${st.size}:${st.mtimeMs}` : await sha256File(abs));
        } catch {}
      }
    } else if (Array.isArray(v)) {
      for (const x of v) await argFileHashes(ws, x, out);
    } else if (isObj(v)) {
      for (const x of Object.values(v)) await argFileHashes(ws, x, out);
    }
    return out;
  }

  const wakeSubmit = (ph, prompt) =>
    ctx.wakeAgent({
      workspace: ph.call.workspace,
      agent: ph.call.agent,
      key: `loremax-${ph.submitId}`,
      ...(ph.call.sessionKey ? { sessionKey: ph.call.sessionKey } : {}),
      prompt,
    });

  /**
   * The generation's own job row takes over from the placeholder before it goes:
   * a restart in between loses neither. A row that cannot be written fails the
   * placeholder (naming the generation) and throws.
   */
  function adopt(ph, job) {
    try {
      trackGeneration(ph.call, job);
    } catch (e) {
      settleSubmit(ph, "failed", { generationId: job.generationId, error: e?.message ?? e });
      throw e;
    }
    settleSubmit(ph, "succeeded", { generationId: job.generationId });
  }

  /**
   * A submission's synchronous result saved and billed under its own job row →
   * { done } | { error }. loremax_result finds the row once it is saved; a failed
   * save leaves it running, and the watcher tries again and wakes the agent.
   */
  async function saveSubmitted(ph, job, result) {
    const { generationId } = job;
    // loremax_result answers "being saved" meanwhile, and nothing else saves it
    inFlight.add(generationId);
    // a retried save (watcher, loremax_result) reads these from the row, never /check
    job.syncResult = result;
    try {
      adopt(ph, job);
      const done = await outputs.finish(ph.call, job, { result, fromReply: true });
      generations.delete(generationId);
      return { done };
    } catch (error) {
      return { error };
    } finally {
      inFlight.delete(generationId);
    }
  }

  const wakeSaved = (ph, job, { done, error }) => {
    // a failed save with a job row is the watcher's now: it tries again and wakes the agent
    if (error && job.trackedId) return ctx.log.warn(`loremax ${job.generationId}: saving its outputs failed: ${error?.message ?? error}`);
    wakeSubmit(ph, done
      ? `${ph.what} — generation ${job.generationId} finished: ${savedList(done)} — check them, then continue where you left off${ph.task}.`
      : `${ph.what} — generation ${job.generationId} finished, but saving its outputs failed: ${error?.message ?? error} — check it on LoreMax${ph.task}.`);
  };

  /** `work`'s outcome, or null once `deadline` passes first (the work goes on). */
  async function beforeDeadline(work, deadline) {
    const timer = new AbortController();
    const first = await Promise.race([work, sleep(Math.max(0, deadline - now()), timer.signal).then(() => null)]);
    timer.abort();
    return first;
  }

  const beingSaved = (generationId, tokensCost) => ({
    generation_id: String(generationId),
    status: "in_progress",
    tokens_cost: Number(tokensCost) || 0,
    hint: "LoreMax finished it; the outputs are being saved — end your turn if nothing else is pending: you will be WOKEN with the files",
  });

  /** The wake line for a submission that failed off the tool call. */
  const lateFailure = (ph, e) => {
    const msg = String(e?.message ?? e);
    return e?.ambiguous
      ? `${ph.what}: ${msg}${ph.task}.`
      : `${ph.what} FAILED: ${msg}. Decide whether to retry (other inputs or workflow) or report the blocker${ph.task}.`;
  };

  /**
   * The submission answered after the tool call had replied `submitting`.
   * accept(outcome) → { job, result } (throws for a failed one); explain(error) → the wake line.
   */
  async function settleLate(ph, outcome, accept, explain = (e) => lateFailure(ph, e)) {
    let got;
    try {
      if (outcome.error) throw outcome.error;
      got = accept(outcome);
    } catch (e) {
      settleSubmit(ph, "failed", { error: e?.message ?? e });
      wakeSubmit(ph, await explain(e));
      return;
    }
    // synchronous: save, bill, wake
    if (got.result) return wakeSaved(ph, got.job, await saveSubmitted(ph, got.job, got.result));
    // async: the watcher polls the job row and wakes the agent
    try {
      adopt(ph, got.job);
    } catch (e) {
      wakeSubmit(ph, `${ph.what} — LoreMax accepted it as generation ${got.job.generationId}, but tracking it failed (${e?.message ?? e}) — check it on LoreMax${ph.task}.`);
    }
  }

  /** The submission raced against the budget: its outcome, or null once `until` passes first (never on a blocking core). */
  async function raceBudget(ph, submission, until) {
    return ph ? beforeDeadline(submission, until) : submission;
  }

  /**
   * An accepted submission within the budget → the tool reply: a synchronous
   * result is finished (in the background when too close to the deadline), an
   * async one is tracked and polled with what is left of the budget.
   */
  async function landed(call, ph, { job, result }, { until, deadline, waitS }) {
    if (result) {
      // an older core blocks on the downloads as in 0.1.0
      if (!ph) return outputs.finish(call, { ...job, trackedId: null }, { result, fromReply: true });
      // downloads must not outlast the client: too close to the deadline, or past it,
      // the save goes on in the background and the agent is woken with the files
      const saving = saveSubmitted(ph, job, result);
      const first = deadline - now() < FINISH_RESERVE_MS ? null : await beforeDeadline(saving, deadline);
      if (!first) {
        saving.then((o) => wakeSaved(ph, job, o)).catch((e) => ctx.log.warn(`loremax ${ph.submitId}: ${e?.message ?? e}`));
        return beingSaved(job.generationId, job.tokensCost);
      }
      if (first.error) throw first.error;
      return first.done;
    }
    if (ph) adopt(ph, job);
    else trackGeneration(call, job);
    return waitFor(call, job, { until, deadline, waitS });
  }

  registerTool({
    name: "loremax_generate",
    description:
      `Run a LoreMax workflow (image, video, audio, 3D or text) and wait for the result. inputs are passed through unchanged — name them exactly as loremax_workflows lists the workflow's input fields. references are artifacts/… paths or workspace files (each ≤ 20MB, up to 20) sent to LoreMax as files. Outputs are downloaded into this task's artifacts with provenance; the reply lists their paths. Every call is PAID in LoreMax tokens: read the workflow's fields and price with loremax_workflows first. Waits at most ${MAX_WAIT_S}s: if the wait runs out you get status in_progress (with a generation_id) or submitting back and are WOKEN when it lands (or poll loremax_result with the generation_id). Never call it again for a submitting reply.`,
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
      const key = submitKey({ mode: "rest", workflow, args: inputs, refs: await Promise.all(files.map(sha256File)), target: submitTarget(), call });
      if (submitting.has(key)) return text(JSON.stringify(duplicateReply(key, { workflow }), null, 1));

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
      const ph = ctx.jobs && ctx.wakeAgent ? trackSubmit(call, { mode: "rest", workflow, note, key }) : null;
      const submission = execute(init).then((sub) => ({ sub }), (error) => ({ error }));
      if (!ph) holdWhile(key, submission);
      const first = await raceBudget(ph, submission, until);
      if (!first) {
        submission.then((o) => settleLate(ph, o, ({ sub }) => accepted(call, sub, base))).catch((e) => ctx.log.warn(`loremax ${ph.submitId}: ${e?.message ?? e}`));
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
      return text(JSON.stringify(await landed(call, ph, got, { until, deadline, waitS }), null, 1));
    },
  });

  registerTool({
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
   * The optional fourth tool: rewrites the profile's texts in LoreMax, which every
   * client of the profile sees. Profile mode with allow_profile_edit only — an agent
   * that may not edit never sees it; an invalid profile_url makes it throw the
   * config error like every other tool.
   */
  if (profile && lmx.allowProfileEdit()) {
    const edit = createProfileEditor(lmx, {
      profileManagementId: createProfileManagementId(lmx),
      onSaved: () => {
        catalog?.markStale();
        instructions?.invalidate();
      },
    });
    registerTool({
      name: "loremax_profile_edit",
      description:
        `Edit this LoreMax MCP profile's texts: the profile description (the studio's instructions) and the descriptions of its bound tools — never which tools are bound, their names or whether the profile is active. Changes what EVERY client of the profile sees. Always preview first (apply false, the default: nothing is saved) and show the changes; then call again with apply: true to save. Each text is at most ${PROFILE_TEXT_MAX} characters; null or "" clears it.`,
      schema: {
        instructions: z.string().max(PROFILE_TEXT_MAX).nullable().optional().describe("the profile description; omit to keep it, null or \"\" clears it"),
        tools: z.array(z.object({
          tool: z.string().describe("the tool's current name, as loremax_workflows lists it"),
          description: z.string().max(PROFILE_TEXT_MAX).nullable().describe("its new description; null or \"\" clears it"),
        })).optional().describe("tool descriptions to change"),
        apply: z.boolean().optional().describe("true saves; default false previews without saving"),
      },
      handler: async (args) => {
        const deadline = now() + MAX_WAIT_S * 1000;
        return text(cap(JSON.stringify(await edit(args, { deadline }), null, 1)));
      },
    });
  }


  /**
   * Poll /check until completed (→ finish), failed (→ settle + throw) or `until`
   * passes (→ in_progress reply). `deadline` ends every request and Retry-After
   * wait; a result that lands too close to it is left to the watcher to save.
   */
  async function waitFor(call, job, { until, deadline, waitS }) {
    const { generationId, trackedId } = job;
    let landed = false;
    // a save still running past the deadline holds the generation until it is done
    let saving = null;
    inFlight.add(generationId);
    try {
      for (;;) {
        let c;
        try {
          c = await statusOf(job, { deadline });
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
          // the job row settles with the save: past the deadline nothing else would wake the agent
          if (!(ctx.wakeAgent && trackedId)) {
            const done = await outputs.finish(call, job, c);
            generations.delete(generationId);
            return done;
          }
          const work = outputs.finish(call, job, c).then((done) => ({ done }), (error) => ({ error }));
          const first = await beforeDeadline(work, deadline);
          if (first) {
            if (first.error) throw first.error;
            generations.delete(generationId);
            return first.done;
          }
          saving = work;
          break;
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
      if (!saving) inFlight.delete(generationId);
    }
    if (saving) {
      saving
        .then(({ done, error }) => {
          inFlight.delete(generationId);
          // a failed save leaves the job running: the watcher tries again and wakes
          if (error) return ctx.log.warn(`loremax ${generationId}: saving its outputs failed: ${error?.message ?? error}`);
          generations.delete(generationId);
          const label = jobLabel(job.note, job.tokensCost);
          ctx.wakeAgent({
            workspace: call.workspace,
            agent: call.agent,
            // the watcher's key for this row: one wake per generation
            key: `loremax-job:${trackedId}`,
            ...(call.sessionKey ? { sessionKey: call.sessionKey } : {}),
            prompt: `LoreMax generation ${generationId} (${job.workflow || "workflow"} — ${label}) finished: ${savedList(done)} — check them, then continue where you left off${call.taskId ? ` (task ${call.taskId})` : ""}.`,
          });
        })
        .catch((e) => ctx.log.warn(`loremax ${generationId}: ${e?.message ?? e}`));
      return beingSaved(generationId, job.tokensCost);
    }
    if (landed)
      return {
        generation_id: String(generationId),
        status: "in_progress",
        tokens_cost: Number(job.tokensCost) || 0,
        hint: ctx.jobs && ctx.wakeAgent
          ? "LoreMax finished it; the outputs are being saved — end your turn if nothing else is pending: you will be WOKEN with the files (or poll loremax_result)"
          : "LoreMax finished it — call loremax_result with this generation_id to save the outputs",
      };
    const waited = Math.round(waitS);
    return {
      generation_id: String(generationId),
      status: "in_progress",
      tokens_cost: Number(job.tokensCost) || 0,
      hint: ctx.jobs && ctx.wakeAgent
        ? `still rendering after ${waited}s — end your turn if nothing else is pending: you will be WOKEN when it lands (or poll loremax_result)`
        : `still rendering after ${waited}s — call loremax_result with this generation_id (the work continues on LoreMax's side)`,
    };
  }

  // Reboot-proof: pending generations from the job rows are polled here, so a
  // run that died mid-wait (restart, crash, wait budget) still gets its
  // outputs saved and the agent woken in the session it came from.
  let watching = false;
  // false once a newer activation replaced this watcher or it shut down: clearInterval
  // stops future ticks only, a pass already running stops at its next row
  let active = true;
  // finished generations whose save failed here: the agent was woken with the error and
  // saves them with loremax_result — not downloaded again every pass (until the 6h give-up)
  const unsaved = new Set();
  // generation id → when the watcher checks it next (see checkEveryMs). Per activation:
  // only one watcher runs, and a fresh one checks every pending job once first
  const nextCheck = new Map();
  async function watchOnce() {
    if (watching || !active || !ctx.jobs) return;
    watching = true;
    try {
      // the schedule counts from the pass's start, not from each /check: a later
      // row in a slow pass is still due on the tick its cadence lands on
      const passAt = now();
      const rows = ctx.jobs.pending();
      // settled meanwhile (here, by a tool call or elsewhere): forget its schedule
      const pendingIds = new Set(rows.map((j) => j.externalId));
      for (const id of nextCheck.keys()) if (!pendingIds.has(id)) nextCheck.delete(id);
      for (const j of rows) {
        if (!active) break;
        if (inFlight.has(j.externalId)) continue;
        if (unsaved.has(j.externalId) && now() - Date.parse(j.createdAt) <= GIVE_UP_MS) continue;
        // half a tick of slack: setInterval's clock and Date.now() drift apart, so passes
        // can land 14 999 ms apart, and a due row must not wait a whole extra tick
        if ((nextCheck.get(j.externalId) ?? 0) > passAt + WATCH_MS / 2) continue;
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
          const job = { ...(generations.get(j.externalId) ?? fromRow(j.externalId, j, cur)), trackedId: j.id };
          let c = null;
          // a failed /check keeps this schedule too: no tight retry against a rate limit
          nextCheck.set(j.externalId, passAt + checkEveryMs(passAt - Date.parse(j.createdAt)));
          try {
            c = await statusOf(job);
          } catch (e) {
            if (!expired) throw e;
            ctx.log.warn(`loremax job ${j.externalId}: ${e?.message ?? e}`);
          }
          if (c?.status === "completed") {
            const call = { workspace: j.workspace, agent: j.agent, runId: null, sessionKey: j.sessionKey, taskId: j.taskId };
            let done;
            try {
              done = await outputs.finish(call, job, c);
            } catch (e) {
              const error = String(e?.message ?? e);
              ctx.log.warn(`loremax job ${j.externalId}: saving its outputs failed: ${error}`);
              if (expired) {
                generations.delete(j.externalId);
                unsaved.delete(j.externalId);
                ctx.jobs.settle(j.id, { status: "failed", result: { workspace: j.workspace }, error: `saving its outputs failed: ${error}`.slice(0, 300) });
                wake(`${what} finished, but saving its outputs still failed after 6h: ${error} — it was given up; check it on LoreMax${task}.`);
              } else if (!unsaved.has(j.externalId)) {
                unsaved.add(j.externalId);
                // its own key: the row's key stays free for a wake with the files after a restart
                ctx.wakeAgent?.({ workspace: j.workspace, agent: j.agent, key: `loremax-save:${j.id}`, ...(j.sessionKey ? { sessionKey: j.sessionKey } : {}),
                  prompt: `${what} finished, but saving its outputs failed: ${error}${error.includes("loremax_result") ? "" : ` — fix that, then call loremax_result with generation_id ${j.externalId}`}${task}.` });
              }
              continue;
            }
            unsaved.delete(j.externalId);
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
  // One watcher per process: an update, settings save or dashboard toggle activates
  // the plugin again without always shutting the old instance down, and two watchers
  // would poll every pending job twice. The handle is process-wide for that reason.
  const slot = WATCHER_SLOT;
  if (globalThis[slot]) {
    clearInterval(globalThis[slot].interval);
    globalThis[slot].stop?.();
    delete globalThis[slot];
  }
  if (ctx.jobs) {
    const watcher = setInterval(watchOnce, WATCH_MS);
    watcher.unref?.();
    const stop = () => (active = false);
    globalThis[slot] = { interval: watcher, generations, stop };
    ctx.onShutdown?.(() => {
      clearInterval(watcher);
      stop();
      // a late shutdown of an older instance leaves the current watcher alone; the jobs stay for the next activation
      if (globalThis[slot]?.interval === watcher) globalThis[slot] = { generations };
    });
  }

  /**
   * get_balance on the endpoint of the mode: the profile path in profile mode
   * (same key, and it proves the profile answers), else /api/mcp. An invalid
   * profile_url throws its config error before any HTTP.
   */
  const balance = (opts) => {
    if (profile?.error) throw profile.error;
    return profile ? lmx.toolCall(profile.path, "get_balance", {}, opts) : lmx.mcpCall("get_balance", {}, opts);
  };

  ctx.registerCheck?.(async () => {
    if (profile?.error) return { ok: false, message: profile.error.message };
    if (!lmx.hasKey()) return { ok: false, message: "no key: LOREMAX_API_KEY is not set" };
    try {
      const b = await balance({ timeoutMs: 15_000 });
      const remaining = Number(b?.remaining);
      if (!profile) {
        return remaining > 0
          ? { ok: true, message: `key works · ${remaining} tk left` }
          : { ok: false, message: "key works, but the balance is empty — top up LoreMax" };
      }
      // the check is the one place a person asks "is it set up?": reread the catalog, not the cached one
      let n;
      try {
        n = (await catalog.get({ force: true, deadline: now() + 15_000 })).tools.size;
      } catch (e) {
        // the key works (get_balance answered): it is the profile's catalog that failed
        return { ok: false, message: `key works, but the profile's tools/list failed: ${short(e?.message ?? e)}` };
      }
      const reach = `profile reachable, ${n} tool${n === 1 ? "" : "s"}`;
      if (n === 0) return { ok: false, message: `${reach} — add workflows to the profile in LoreMax → Organization → MCP` };
      return remaining > 0
        ? { ok: true, message: `${reach} · ${remaining} tk left` }
        : { ok: false, message: `${reach}, but the balance is empty — top up LoreMax` };
    } catch (e) {
      // these messages already name the cause and the fix: a 404 profile, a config error, a refused redirect
      if (e?.code === "PROFILE_NOT_FOUND" || e?.config || e?.status === 0) return { ok: false, message: e.message };
      return { ok: false, message: `LoreMax refused the key (${e?.status ?? short(e?.message ?? e)})` };
    }
  });

  // dashboard balance tile; polled by the UI, so cached a minute
  let balanceCache = { at: -Infinity, tiles: [] };
  ctx.registerStat?.(async () => {
    if (!lmx.hasKey() || profile?.error) return [];
    if (now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.tiles;
    try {
      const b = await balance({ timeoutMs: 2_500 });
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
