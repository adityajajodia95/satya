// Bounded retries for local model servers (mirrors the gateway's policy in the cloud: ≤ 2 retries with
// exponential backoff), so a transient Ollama hiccup during a multi-day evaluation does not become an NEI.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const transient = (e: unknown) =>
  e instanceof HttpError
    ? e.status === 429 || e.status >= 500
    : e instanceof TypeError || (e as Error).name === "TimeoutError";

export async function withRetries<T>(
  fn: () => Promise<T>,
  { retries = 2, baseMs = 1000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !transient(e)) throw e;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

/** POST JSON and parse the JSON reply; non-2xx → HttpError (retried when transient). */
export async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  return withRetries(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new HttpError(res.status, `${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  });
}
