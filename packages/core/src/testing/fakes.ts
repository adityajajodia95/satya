// Deterministic test doubles shared across packages.
// Deterministic stand-ins for the cloud embedder/re-ranker, used where no real model may be called.
import type { Clock, Embedder, EventSink, LLM, LlmRequest, LlmResponse, Reranker } from "../ports";
import type { RunEvent, Span } from "../schemas";
import { tokenize } from "../retrieval/bm25";

const DIM = 256;

/** FNV-1a hash of a token into a bucket. */
function bucket(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0) % DIM;
}

/** Hashed bag-of-words embedding: similar wording → similar vectors. */
export class FakeEmbedder implements Embedder {
  calls: { texts: string[]; kind: "query" | "doc" }[] = [];
  embed(texts: string[], kind: "query" | "doc"): Promise<Float32Array[]> {
    this.calls.push({ texts, kind });
    return Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(DIM);
        for (const token of tokenize(t)) v[bucket(token)]! += 1;
        return v;
      }),
    );
  }
}

/** Token-overlap "cross-encoder": logit = 4·(overlap fraction) − 2. */
export class FakeReranker implements Reranker {
  calls: { query: string; passages: string[] }[] = [];
  score(query: string, passages: string[]): Promise<number[]> {
    this.calls.push({ query, passages });
    const q = new Set(tokenize(query));
    return Promise.resolve(
      passages.map((p) => {
        const tokens = new Set(tokenize(p));
        const overlap = [...q].filter((t) => tokens.has(t)).length / Math.max(1, q.size);
        return 4 * overlap - 2;
      }),
    );
  }
}

// ── LLM / sink / clock fakes ───────────────────────────────────────────────────────────────────────

export type FakeReply = unknown | ((req: LlmRequest, callIndex: number) => unknown);

/**
 * Scripted LLM: replies are looked up by task (the prompt name) and consumed in order; a function reply
 * is called with the request. Objects are returned as JSON text; strings are returned verbatim.
 */
export class FakeLLM implements LLM {
  readonly calls: LlmRequest[] = [];
  private readonly queues: Map<string, FakeReply[]>;

  constructor(
    script: Record<string, FakeReply[] | FakeReply> = {},
    private readonly fallback?: (req: LlmRequest) => unknown,
  ) {
    this.queues = new Map(Object.entries(script).map(([task, r]) => [task, Array.isArray(r) ? [...r] : [r]]));
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.push(req) - 1;
    const queue = this.queues.get(req.task);
    let reply: unknown;
    if (queue && queue.length > 1) reply = queue.shift();
    else if (queue && queue.length === 1)
      reply = queue[0]; // the last reply repeats
    else if (this.fallback) reply = await this.fallback(req);
    else throw new Error(`FakeLLM: no scripted reply for task "${req.task}"`);
    // Reply functions may be async (e.g. to delegate to another fake or to throw).
    const value =
      typeof reply === "function"
        ? await (reply as (r: LlmRequest, i: number) => unknown)(req, index)
        : reply;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const input = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      text,
      usage: { input, output: Math.ceil(text.length / 4) },
      model: "fake-llm",
      provider: "fake",
    };
  }
}

export class MemorySink implements EventSink {
  readonly events: Omit<RunEvent, "seq" | "ts">[] = [];
  readonly spans: Span[] = [];
  emit(e: Omit<RunEvent, "seq" | "ts">): Promise<void> {
    this.events.push(e);
    return Promise.resolve();
  }
  span(s: Span): Promise<void> {
    this.spans.push(s);
    return Promise.resolve();
  }
}

/** Advances 10 ms per call, so traces get deterministic non-zero durations. */
export class TickClock implements Clock {
  private t = 1_760_000_000_000;
  now(): number {
    return (this.t += 10);
  }
}
