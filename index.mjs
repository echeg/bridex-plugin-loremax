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
const KEY_HINT = "LOREMAX_API_KEY is not set — Settings → Integrations → LoreMax (or plugins.loremax.config.api_key)";

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

  return { cfg, key, hasKey: () => Boolean(rawKey()), baseUrl, usdPerToken, restJson, mcpCall };
}

export default async function activate(ctx) {
  const lmx = createClient(ctx);
  // tools still register without a key: each call surfaces the Settings hint,
  // and setting the credential needs no restart
  if (!lmx.hasKey()) ctx.needsConfig("Add the LoreMax API key (Settings → Integrations, LOREMAX_API_KEY).");

  ctx.log.info("loremax plugin active");
}
