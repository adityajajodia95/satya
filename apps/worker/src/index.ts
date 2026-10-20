// satya-api (§7 M10): public routes under /api/satya (forwarded unchanged by the Pages router), the remote
// MCP endpoint, admin parity routes, and the nightly parity cron.
import { ALL_SOURCES, SourceChoice, countSentences, initialState, variantFor } from "@satya/core";
import { z } from "zod";
import gallery from "../../../gallery/index.json";
import { CLOUD, CONFIG, CONFIG_VERSION, EST_GROQ_TOKENS_PER_CLAIM, MODEL_LABEL } from "./config";
import { type Provider, type SatyaEnv, archiveOf, gatewayOf, hubOf } from "./env";
import { handleMcp } from "./mcp";
import type { ParityItem } from "./archive";
import { startNextParity } from "./parity";
import type { RunMeta } from "./runhub";

export { ArchiveDO } from "./archive";
export { RunHubDO } from "./runhub";
export { SatyaWorkflow } from "./workflow";

const PREFIX = "/api/satya";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const apiError = (
  status: number,
  code: string,
  message: string,
  retryAfterS = 0,
  fallback: "gallery" | "none" = "none",
) =>
  json(
    { error: { code, message, retryAfterS, fallback } },
    status,
    retryAfterS ? { "Retry-After": String(retryAfterS) } : {},
  );

const RunBody = z.object({ text: z.string(), sources: z.array(SourceChoice).optional() });
const ParityBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        dataset: z.enum(["scifact", "fever", "hover"]),
        claim: z.string().min(1).max(2000),
        gold: z.string(),
        passages: z
          .array(z.object({ id: z.string(), title: z.string(), text: z.string() }))
          .max(20)
          .optional(),
      }),
    )
    .max(500),
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** C4: the cache key covers text, the selected sources, the config version and the model. */
export const cacheKeyFor = async (text: string, sources: readonly string[]) =>
  `satya:report:${await sha256Hex([text, [...sources].sort().join(","), CONFIG_VERSION, MODEL_LABEL].join("|"))}`;

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const isAdmin = (request: Request, env: SatyaEnv) =>
  request.headers.get("Authorization") === `Bearer ${env.SATYA_ADMIN_TOKEN}`;
/** Owner mode (your own browser): skips Turnstile and the per-IP limit; budgets still apply. */
const isOwner = (request: Request, env: SatyaEnv) =>
  Boolean(env.SATYA_OWNER_TOKEN) && request.headers.get("X-Satya-Owner") === env.SATYA_OWNER_TOKEN;

interface Visitor {
  ipHash: string;
  sessionId: string | null;
  privileged: boolean;
}

async function visitor(request: Request, env: SatyaEnv): Promise<Visitor> {
  const gateway = gatewayOf(env);
  const ipHash = await gateway.hashIp(request.headers.get("CF-Connecting-IP") ?? "0.0.0.0");
  const privileged = isAdmin(request, env) || isOwner(request, env);
  const token = cookie(request, "aj_s");
  const session = token ? await gateway.checkSession({ token, ipHash }) : { ok: false };
  return { ipHash, sessionId: session.ok ? (session.sessionId ?? null) : null, privileged };
}

async function createRun(request: Request, env: SatyaEnv): Promise<Response> {
  const parsed = RunBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "bad_request", "Send JSON: { text, sources? }");
  const text = parsed.data.text.trim();
  if (!text) return apiError(400, "bad_request", "Paste some text to check.");
  if (text.length > CLOUD.maxInputChars)
    return apiError(
      400,
      "bad_request",
      `Text is limited to ${CLOUD.maxInputChars.toLocaleString("en-IN")} characters.`,
    );
  const sources = parsed.data.sources?.length ? [...new Set(parsed.data.sources)] : [...ALL_SOURCES];

  const who = await visitor(request, env);
  if (!who.privileged && !who.sessionId)
    return apiError(401, "session_required", "Verification expired — please try again.");

  // C3: a cached result is free — checked before the per-IP limit.
  const archive = archiveOf(env);
  const cacheKey = await cacheKeyFor(text, sources);
  const cachedRun = await archive.cacheGet(cacheKey);
  if (cachedRun) return json({ runId: cachedRun, cached: true });

  // Pin one provider for the whole run (capacity checked before spending the visitor's quota).
  const gateway = gatewayOf(env);
  const claims = Math.min(CLOUD.maxClaims, Math.max(1, countSentences(text)));
  const left = await gateway.remaining("satya");
  const pin: Provider | null =
    left.neurons >= claims * CLOUD.estNeuronsPerClaim
      ? "workersai"
      : left.groqTokens >= claims * EST_GROQ_TOKENS_PER_CLAIM
        ? "groq"
        : null;
  if (!pin) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return apiError(
      507,
      "capacity_exhausted",
      "Today's free capacity is used — explore recorded runs; live checks reset at 05:30 IST.",
      Math.ceil((midnight.getTime() - Date.now()) / 1000),
      "gallery",
    );
  }

  if (!who.privileged) {
    const quota = await gateway.consume({ project: "satya", kind: "run", ipHash: who.ipHash });
    if (!quota.ok) {
      return apiError(
        429,
        "rate_limited",
        "You've used today's 3 live checks. Recorded runs are still available.",
        Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1000),
        "gallery",
      );
    }
  }

  const runId = crypto.randomUUID();
  const variant = variantFor("satya_full", CONFIG, { decompose: true, evidence: "tools" });
  const meta: RunMeta = { runId, createdAt: new Date().toISOString(), pin, budgetClass: "demo", cacheKey };
  await hubOf(env, runId).init(
    meta,
    initialState({ runId, text, sources, maxClaims: CLOUD.maxClaims, variant }),
  );
  await archive.addRun({
    id: runId,
    preview: text,
    model: MODEL_LABEL,
    provider: pin,
    inputHash: cacheKey,
    owner: who.sessionId ?? (who.privileged ? "owner" : null),
  });
  await env.SATYA_WORKFLOW.create({ id: runId, params: { runId } });
  return json({ runId, cached: false, provider: pin }, 202);
}

export async function handle(request: Request, env: SatyaEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
  const parts = path.split("/").filter(Boolean);
  const method = request.method;

  if (parts[0] === "mcp") return handleMcp(request, env);
  if (parts[0] === "gallery" && method === "GET")
    return json(gallery, 200, { "Cache-Control": "public, max-age=300" });

  if (parts[0] === "runs") {
    const runId = parts[1];
    if (!runId && method === "POST") return createRun(request, env);
    if (!runId && method === "GET") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter((s) => /^[\w-]{8,64}$/.test(s));
      return json({ runs: await archiveOf(env).runs(ids) });
    }
    if (runId && !/^[\w-]{8,64}$/.test(runId)) return apiError(400, "bad_request", "Invalid run id");
    if (runId && parts[2] === "events" && method === "GET") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      return json({ events: await hubOf(env, runId).events(after) });
    }
    if (runId && !parts[2] && method === "GET") {
      const r = await hubOf(env, runId).report();
      return r
        ? json(r)
        : apiError(404, "not_found", "This run doesn't exist or has expired (runs are kept for 30 days).");
    }
    if (runId && !parts[2] && method === "DELETE") {
      const who = await visitor(request, env);
      const owner = who.sessionId ?? (who.privileged ? "owner" : null);
      if (!owner || !(await archiveOf(env).deleteRun(runId, owner)))
        return apiError(403, "forbidden", "Only the browser session that created a run can delete it.");
      return json({ deleted: runId });
    }
  }

  if (parts[0] === "admin") {
    if (!isAdmin(request, env)) return apiError(401, "unauthorized", "Bearer token required");
    const archive = archiveOf(env);
    if (parts[1] === "parity" && parts[2] === "enqueue" && method === "POST") {
      const body = ParityBody.safeParse(await request.json().catch(() => null));
      if (!body.success) return apiError(400, "bad_request", body.error.message.slice(0, 300));
      return json({
        added: await archive.parityEnqueue(body.data.items as ParityItem[]),
        counts: await archive.parityCounts(),
      });
    }
    if (parts[1] === "parity" && parts[2] === "results" && method === "GET") {
      const lines = (await archive.parityResults()).map((r) => JSON.stringify(r)).join("\n");
      return new Response(lines ? `${lines}\n` : "", {
        headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
      });
    }
    if (parts[1] === "parity" && parts[2] === "status" && method === "GET")
      return json({ counts: await archive.parityCounts() });
  }
  return apiError(404, "not_found", "No such route");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      const code = String((e as Error)?.message ?? "").match(/gateway:([a-z_]+):(\d+):(.*)/);
      if (code?.[1] === "capacity_exhausted")
        return apiError(507, "capacity_exhausted", code[3] ?? "capacity used", Number(code[2]), "gallery");
      return apiError(503, "unavailable", "Something went wrong on our side — please try again.");
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(startNextParity(env).then(() => undefined));
  },
} satisfies ExportedHandler<SatyaEnv>;
