// RunHubDO (one per run, §7 M9): holds the run state and executes the core pipeline steps against it, so the
// Workflow only orchestrates step names (tiny, replay-cheap results). Events + trace spans for the UI, the
// final report, and auto-deletion after `archiveDays` (alarm).
import { DurableObject } from "cloudflare:workers";
import {
  Bm25Index,
  type CorpusIndex,
  PIPELINE_ERROR,
  type Passage,
  type Ports,
  type Report,
  type RunEvent,
  type RunState,
  type Span,
  type StepContext,
  applyPatch,
  buildReport,
  checkable,
  estimateTotalSteps,
  factuality,
  planSteps,
  retrievalText,
  unverified,
  verdictsOf,
} from "@satya/core";
import { HostRateLimiter, createTools } from "@satya/tools";
import { htmlToTextWorkers } from "@satya/tools/text/workers";
import type { ParityItem } from "./archive";
import { CLOUD, CONFIG, MODEL_LABEL } from "./config";
import { type Provider, type SatyaEnv, archiveOf, gatewayOf } from "./env";
import { gatewayEmbedder, gatewayLlm, gatewayReranker } from "./providers/gateway";

export interface RunMeta {
  runId: string;
  createdAt: string;
  pin: Provider;
  budgetClass: "demo" | "eval";
  cacheKey?: string;
  parity?: ParityItem;
}

export type RunStatus = "running" | "done" | "partial" | "failed";

const TOOL_TTL_S = 72 * 3600;

/** Parses a gateway error message ("gateway:<code>:<retryAfterS>:<text>") that crossed RPC. */
export function gatewayCode(e: unknown): string | null {
  return String((e as Error)?.message ?? e).match(/gateway:([a-z_]+):/)?.[1] ?? null;
}

export class RunHubDO extends DurableObject<SatyaEnv> {
  private readonly sql: SqlStorage;
  private state: RunState | null = null;
  private meta: RunMeta | null = null;
  private corpus: CorpusIndex | undefined;
  /** Test hook: replaces gateway-backed ports. */
  portsOverride: Partial<Ports> | null = null;

  constructor(ctx: DurableObjectState, env: SatyaEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spans (id INTEGER PRIMARY KEY AUTOINCREMENT, span TEXT NOT NULL);
    `);
  }

  // ── persistence ─────────────────────────────────────────────────────────────────────────────────

  private get<T>(k: string): T | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }
  private set(k: string, v: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, JSON.stringify(v));
  }
  private load(): { state: RunState; meta: RunMeta } {
    this.state ??= this.get<RunState>("state");
    this.meta ??= this.get<RunMeta>("meta");
    if (!this.state || !this.meta) throw new Error("run not initialised");
    return { state: this.state, meta: this.meta };
  }
  private save(): void {
    this.set("state", this.state);
  }
  status(): RunStatus {
    return this.get<RunStatus>("status") ?? "running";
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────

  async init(meta: RunMeta, state: RunState): Promise<void> {
    if (this.get("meta")) return; // idempotent
    this.meta = meta;
    this.state = state;
    this.set("meta", meta);
    this.save();
    this.set("status", "running");
    await this.ctx.storage.setAlarm(Date.now() + CLOUD.archiveDays * 86_400_000);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private emitNow(type: RunEvent["type"], data: unknown): void {
    this.sql.exec(
      "INSERT INTO events (ts, type, data) VALUES (?, ?, ?)",
      Date.now(),
      type,
      JSON.stringify(data ?? null),
    );
  }

  private ports(meta: RunMeta): Ports {
    const gateway = gatewayOf(this.env);
    const archive = archiveOf(this.env);
    const sql = this.sql;
    const emit = (type: RunEvent["type"], data: unknown) => this.emitNow(type, data);
    const base: Ports = {
      llm: gatewayLlm(gateway, meta.pin, meta.budgetClass),
      embedder: gatewayEmbedder(gateway),
      reranker: gatewayReranker(gateway),
      tools: createTools({
        config: CONFIG.tools,
        htmlToText: htmlToTextWorkers,
        limiter: new HostRateLimiter(),
        cache: {
          get: (key) => archive.toolGet(key),
          put: (key, docs, ttlS) => archive.toolPut(key, docs, ttlS),
        },
        cacheTtlS: TOOL_TTL_S,
        ...(this.env.TAVILY_API_KEY
          ? {
              tavily: {
                apiKey: this.env.TAVILY_API_KEY,
                guard: { tryConsume: () => archive.creditTryConsume("tavily", CLOUD.tavilyMonthlyGuard) },
              },
            }
          : {}),
      }),
      sink: {
        emit: (e) => Promise.resolve(emit(e.type, e.data)),
        span: (s: Span) =>
          Promise.resolve(void sql.exec("INSERT INTO spans (span) VALUES (?)", JSON.stringify(s))),
      },
      clock: { now: () => Date.now() },
    };
    return { ...base, ...(this.portsOverride ?? {}) };
  }

  /** SciFact parity items carry their own closed corpus (the laptop's top-20 chunks, C2). */
  private async corpusFor(meta: RunMeta, ports: Ports): Promise<CorpusIndex | undefined> {
    const shipped = meta.parity?.passages;
    if (!shipped?.length) return undefined;
    if (this.corpus) return this.corpus;
    const passages: Passage[] = shipped.map((p) => ({
      id: p.id,
      source: "corpus",
      url: null,
      title: p.title,
      text: p.text,
      published: null,
    }));
    const vectors = await ports.embedder.embed(passages.map(retrievalText), "doc");
    this.corpus = { passages, vectors, bm25: new Bm25Index(passages.map(retrievalText)) };
    return this.corpus;
  }

  // ── orchestration (called from SatyaWorkflow steps) ──────────────────────────────────────────────

  async start(): Promise<void> {
    const { state, meta } = this.load();
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n > 0) return;
    this.emitNow("run_started", {
      runId: meta.runId,
      model: MODEL_LABEL,
      provider: meta.pin,
      executor: "cloud",
      total: estimateTotalSteps(state, CONFIG),
    });
  }

  frontier(): { name: string; kind: string }[] {
    const { state } = this.load();
    if (this.status() === "failed") return [];
    return planSteps(state, CONFIG).map((s) => ({ name: s.name, kind: s.kind }));
  }

  /** Runs one named step against the current state. Throws for retryable failures (Workflow retries). */
  async execute(name: string): Promise<{ ok: true; skipped?: true; capacity?: true }> {
    const { state, meta } = this.load();
    const step = planSteps(state, CONFIG).find((s) => s.name === name);
    if (!step) return { ok: true, skipped: true }; // already applied (e.g. a retried step whose result was lost)
    const ports = this.ports(meta);
    const ctx: StepContext = {
      ports,
      config: CONFIG,
      ...(meta.parity?.passages ? { corpus: await this.corpusFor(meta, ports) } : {}),
    } as StepContext;
    let patch;
    try {
      patch = await step.run(ctx, state);
    } catch (e) {
      if (gatewayCode(e) === "capacity_exhausted") {
        // §7 M9: capacity ran out mid-run → remaining claims are NEI "capacity", report partial.
        const open = checkable(this.state!)
          .filter((c) => !this.state!.perClaim[c.id]?.verdict)
          .map((c) => c.id);
        this.state = applyPatch(this.state!, { type: "capacity", claimIds: open });
        this.save();
        this.emitNow("capacity", {
          claimIds: open,
          message: "Today's free capacity ran out during this run.",
        });
        for (const id of open) this.emitNow("verdict", this.state.perClaim[id]!.verdict);
        return { ok: true, capacity: true };
      }
      throw e;
    }
    this.state = applyPatch(this.state!, patch); // apply to the latest state (frontier steps run concurrently)
    this.save();
    const done =
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'stage'").one().n + 1;
    this.emitNow("stage", {
      step: done,
      of: Math.max(done, estimateTotalSteps(this.state, CONFIG)),
      last: name,
    });
    return { ok: true };
  }

  /** After the Workflow gives up on a step: a claim step → NEI "pipeline error"; `decompose` → run failed. */
  fail(name: string, message: string): void {
    const { state } = this.load();
    const step = planSteps(state, CONFIG).find((s) => s.name === name);
    if (!step) return;
    if (!step.claimId) {
      this.set("status", "failed");
      this.emitNow("run_failed", { step: name, message: message.slice(0, 300) });
      return;
    }
    const verdict = unverified(step.claimId, PIPELINE_ERROR);
    this.state = applyPatch(state, { type: "verdict", claimId: step.claimId, verdict });
    this.save();
    this.emitNow("verdict", { ...verdict, error: `${name}: ${message.slice(0, 200)}` });
  }

  /** Builds and stores the report, updates the archive and the cache. */
  async finalize(): Promise<{ status: RunStatus; factuality: number | null }> {
    const { state, meta } = this.load();
    const archive = archiveOf(this.env);
    if (this.status() === "failed") {
      await archive.completeRun(meta.runId, null, 0, "failed");
      return { status: "failed", factuality: null };
    }
    const report = this.buildReport();
    this.set("report", report);
    const status: RunStatus = state.partial ? "partial" : "done";
    this.set("status", status);
    await archive.completeRun(meta.runId, report.factuality, checkable(state).length, status);
    if (meta.cacheKey && status === "done")
      await archive.cachePut(meta.cacheKey, meta.runId, CLOUD.archiveDays);
    if (meta.parity) {
      const v = state.perClaim.c1?.verdict;
      if (status === "partial") await archive.parityRequeue(meta.parity.id);
      else
        await archive.parityDone(meta.parity.id, {
          id: meta.parity.id,
          dataset: meta.parity.dataset,
          gold: meta.parity.gold,
          rawLabel: v?.rawLabel ?? "NOT_ENOUGH_INFO",
          confidence: v?.confidence ?? 0,
          samples: v?.samples ?? [],
          cited: v?.cited.length ?? 0,
          provider: meta.pin,
          neurons: report.trace.reduce((s, t) => s + (t.neurons ?? 0), 0),
          inTok: report.trace.reduce((s, t) => s + t.inTok, 0),
          outTok: report.trace.reduce((s, t) => s + t.outTok, 0),
          llmCalls: report.trace.length,
          runId: meta.runId,
        });
    }
    this.emitNow("run_completed", { factuality: report.factuality, partial: state.partial });
    return { status, factuality: report.factuality };
  }

  private buildReport(): Report {
    const { state, meta } = this.load();
    const trace = this.sql
      .exec<{ span: string }>("SELECT span FROM spans ORDER BY id")
      .toArray()
      .map((r) => JSON.parse(r.span) as Span);
    return buildReport(state, trace, {
      model: MODEL_LABEL,
      provider: meta.pin,
      createdAt: meta.createdAt,
      executor: "cloud",
    });
  }

  // ── reads (API) ─────────────────────────────────────────────────────────────────────────────────

  events(after: number, limit = 200): RunEvent[] {
    return this.sql
      .exec<{ seq: number; ts: number; type: RunEvent["type"]; data: string }>(
        "SELECT seq, ts, type, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        limit,
      )
      .toArray()
      .map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) as unknown }));
  }

  /** The final report, or the partial report built from the current state while running. */
  report(): { status: RunStatus; report: Report } | null {
    if (!this.get("meta")) return null;
    const stored = this.get<Report>("report");
    return { status: this.status(), report: stored ?? this.buildReport() };
  }

  summary(): { status: RunStatus; claims: number; verdicts: number; factuality: number | null } {
    const { state } = this.load();
    const verdicts = verdictsOf(state);
    return {
      status: this.status(),
      claims: checkable(state).length,
      verdicts: verdicts.length,
      factuality: factuality(verdicts),
    };
  }
}
