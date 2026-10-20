// One HTTP helper for every tool: User-Agent, per-host politeness, per-request timeout, and a small
// number of retries on 429/5xx (honouring Retry-After) inside a total time budget.
import { type ToolContext, ToolFailure } from "./context";

export const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_BUDGET_MS = 18_000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 4_000;

const isRetryable = (status: number) => status === 429 || status >= 500;

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function statusToCode(status: number): ToolFailure["code"] {
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "blocked";
  if (status === 432 || status === 433) return "quota"; // Tavily plan/credit limits
  return "bad_response";
}

export async function request(ctx: ToolContext, url: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = ctx.random ?? Math.random;
  const deadline = Date.now() + (ctx.callBudgetMs ?? DEFAULT_CALL_BUDGET_MS);
  const host = new URL(url).host;
  const headers = new Headers(init.headers);
  headers.set("User-Agent", ctx.config.userAgent);

  for (let attempt = 0; ; attempt++) {
    await ctx.limiter?.wait(host);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ToolFailure("timeout", `time budget exhausted for ${host}`);
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        if (attempt < MAX_RETRIES && deadline - Date.now() > 1000) continue;
        throw new ToolFailure("timeout", `${host} did not answer in time`);
      }
      throw new ToolFailure("network", `${host}: ${(e as Error).message}`);
    }
    const redirect = res.status >= 300 && res.status < 400; // only seen with redirect: "manual"
    if (res.ok || redirect || !isRetryable(res.status) || attempt >= MAX_RETRIES) {
      if (!res.ok && !redirect)
        throw new ToolFailure(statusToCode(res.status), `${host} answered ${res.status}`);
      return res;
    }
    const backoff = random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt); // full jitter
    const wait = parseRetryAfterMs(res.headers.get("retry-after")) ?? backoff;
    await res.body?.cancel();
    if (Date.now() + wait >= deadline) {
      throw new ToolFailure(
        statusToCode(res.status),
        `${host} answered ${res.status}; retry would exceed budget`,
      );
    }
    await sleep(wait);
  }
}

export async function requestJson<T>(ctx: ToolContext, url: string, init?: RequestInit): Promise<T> {
  const res = await request(ctx, url, init);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ToolFailure("bad_response", `${new URL(url).host} returned invalid JSON`);
  }
}
