// The pipeline as data (§6.2): `planSteps(state)` returns the frontier — every step whose inputs are ready —
// in a deterministic order. Executors run a frontier (concurrently or as Workflow steps), then apply the
// patches in frontier order, so both executors walk the same step sequence.
import { aggregateSamples, judgeSample } from "../agents/judge";
import { decompose } from "../agents/decomposer";
import { argue } from "../agents/debaters";
import { type AgentContext, MAX_TOKENS, callJson } from "../agents/llm-call";
import { plan } from "../agents/planner";
import {
  WEB_FETCHES_PER_CLAIM,
  WIKI_PAGES_PER_CLAIM,
  collectPassages,
  planFetches,
  planSearches,
} from "../agents/researcher";
import type { SatyaConfig, SourceChoice } from "../config";
import type { Ports } from "../ports";
import { renderEvidence } from "../prompts";
import type { Bm25Index } from "../retrieval/bm25";
import { retrievalText } from "../retrieval/chunker";
import { type RetrievalConfig, fuseCandidates, selectEvidence } from "../retrieval/pipeline";
import type { Claim, Passage, Side } from "../schemas";
import { type ClaimState, type RunState, type StatePatch, checkable } from "./state";

export type StepKind = "llm" | "tool" | "embed" | "rerank" | "pure";

/** A closed corpus (SciFact) with precomputed bge-m3 vectors and a prebuilt BM25 index. */
export interface CorpusIndex {
  passages: readonly Passage[];
  vectors: readonly Float32Array[];
  bm25: Bm25Index;
}

export interface StepContext {
  ports: Ports;
  config: SatyaConfig;
  corpus?: CorpusIndex;
}

export interface Step {
  name: string;
  kind: StepKind;
  claimId?: string;
  run(ctx: StepContext, state: RunState): Promise<StatePatch>;
}

const SIDES: readonly Side[] = ["advocate", "skeptic"];

const agent = (ctx: StepContext, step: string): AgentContext => ({
  llm: ctx.ports.llm,
  sink: ctx.ports.sink,
  clock: ctx.ports.clock,
  step,
});

function retrievalConfig(state: RunState, cfg: SatyaConfig): RetrievalConfig {
  // dense_only ablation: no BM25 list in the fusion.
  return state.variant.retrieval === "dense" ? { ...cfg.retrieval, bm25K: 0 } : cfg.retrieval;
}

// ── step factories ─────────────────────────────────────────────────────────────────────────────────

const decomposeStep: Step = {
  name: "decompose",
  kind: "llm",
  async run(ctx, state) {
    const claims = await decompose(agent(ctx, "decompose"), state.inputText, ctx.config, state.maxClaims);
    await ctx.ports.sink.emit({ type: "claims", data: { claims } });
    return { type: "claims", claims };
  },
};

const planStep = (claim: Claim): Step => ({
  name: `plan:${claim.id}`,
  kind: "llm",
  claimId: claim.id,
  async run(ctx) {
    const p = await plan(agent(ctx, `plan:${claim.id}`), claim.text, ctx.config);
    await ctx.ports.sink.emit({ type: "queries", data: { claimId: claim.id, ...p } });
    return { type: "plan", claimId: claim.id, plan: p };
  },
});

const toolStep = (
  claim: Claim,
  call: { step: string; tool: Parameters<Ports["tools"]["call"]>[0]; args: object },
): Step => ({
  name: call.step,
  kind: "tool",
  claimId: claim.id,
  async run(ctx) {
    const result = await ctx.ports.tools.call(call.tool, call.args);
    await ctx.ports.sink.emit({
      type: "tool_call",
      data: {
        claimId: claim.id,
        step: call.step,
        tool: call.tool,
        args: call.args,
        ok: result.ok,
        ...(result.ok ? { docs: result.docs.length, cached: result.cached } : { error: result.error }),
      },
    });
    return { type: "tool", claimId: claim.id, step: call.step, result };
  },
});

const embedStep = (claim: Claim): Step => ({
  name: `embed:${claim.id}`,
  kind: "embed",
  claimId: claim.id,
  async run(ctx, state) {
    const cs = state.perClaim[claim.id] as ClaimState;
    const corpus = state.variant.evidence === "corpus" ? ctx.corpus : undefined;
    if (state.variant.evidence === "corpus" && !corpus)
      throw new Error("closed-corpus run without a corpus index");
    const passages = corpus
      ? corpus.passages
      : collectPassages(claim.text, Object.values(cs.tools), ctx.config);
    if (passages.length === 0)
      return { type: "candidates", claimId: claim.id, candidates: [], passageCount: 0 };
    const [queryVector] = await ctx.ports.embedder.embed([claim.text], "query");
    const passageVectors = corpus
      ? corpus.vectors
      : await ctx.ports.embedder.embed(passages.map(retrievalText), "doc");
    const candidates = fuseCandidates(
      {
        query: claim.text,
        passages,
        queryVector: queryVector as Float32Array,
        passageVectors,
        ...(corpus ? { bm25: corpus.bm25 } : {}),
      },
      retrievalConfig(state, ctx.config),
    );
    return { type: "candidates", claimId: claim.id, candidates, passageCount: passages.length };
  },
});

const rerankStep = (claim: Claim): Step => ({
  name: `rerank:${claim.id}`,
  kind: "rerank",
  claimId: claim.id,
  async run(ctx, state) {
    const candidates = (state.perClaim[claim.id] as ClaimState).candidates ?? [];
    // no_rerank ablation: scores are all 0, so the RRF order decides (ties broken by RRF).
    const scores =
      state.variant.rerank && candidates.length
        ? await ctx.ports.reranker.score(
            claim.text,
            candidates.map((c) => retrievalText(c.passage)),
          )
        : candidates.map(() => 0);
    const evidence = selectEvidence(candidates, scores, retrievalConfig(state, ctx.config));
    await ctx.ports.sink.emit({ type: "evidence", data: { claimId: claim.id, evidence } });
    return { type: "evidence", claimId: claim.id, evidence };
  },
});

const argueStep = (claim: Claim, round: number, side: Side): Step => ({
  name: `argue:${claim.id}:r${round}:${side}`,
  kind: "llm",
  claimId: claim.id,
  async run(ctx, state) {
    const cs = state.perClaim[claim.id] as ClaimState;
    const argument = await argue(
      agent(ctx, `argue:${claim.id}:r${round}:${side}`),
      side,
      round,
      claim,
      cs.evidence ?? [],
      cs.debate,
      ctx.config,
    );
    await ctx.ports.sink.emit({ type: "argument", data: argument });
    return { type: "argument", claimId: claim.id, argument };
  },
});

const judgeStep = (claim: Claim, index: number): Step => ({
  name: `judge:${claim.id}:s${index}`,
  kind: "llm",
  claimId: claim.id,
  async run(ctx, state) {
    const cs = state.perClaim[claim.id] as ClaimState;
    const sample = await judgeSample(
      agent(ctx, `judge:${claim.id}:s${index}`),
      claim.text,
      cs.evidence ?? [],
      cs.debate,
      index,
      ctx.config,
    );
    return { type: "sample", claimId: claim.id, index, sample };
  },
});

const verdictStep = (claim: Claim): Step => ({
  name: `verdict:${claim.id}`,
  kind: "pure",
  claimId: claim.id,
  async run(ctx, state) {
    const cs = state.perClaim[claim.id] as ClaimState;
    const samples = Object.entries(cs.samples)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, s]) => s);
    const verdict = aggregateSamples(
      claim.id,
      samples,
      cs.evidence ?? [],
      ctx.config.pipeline.abstainThreshold,
    );
    await ctx.ports.sink.emit({ type: "verdict", data: verdict });
    return { type: "verdict", claimId: claim.id, verdict };
  },
});

/** Baselines: one call gives the label and a verbal confidence (abstain below τ, same rule as Satya). */
const baselineStep = (claim: Claim, prompt: "llm_only" | "single_agent"): Step => ({
  name: `judge:${claim.id}:s1`,
  kind: "llm",
  claimId: claim.id,
  async run(ctx, state) {
    const cs = state.perClaim[claim.id] as ClaimState;
    const evidence = cs.evidence ?? [];
    const values: Record<string, string> =
      prompt === "llm_only"
        ? { claim: claim.text }
        : { claim: claim.text, evidence: renderEvidence(evidence, ctx.config.retrieval.evidenceChars) };
    const { output } = await callJson(agent(ctx, `judge:${claim.id}:s1`), prompt, values, {
      temperature: ctx.config.llm.temperature,
      reasoning: ctx.config.llm.reasoning.judge,
      maxTokens: MAX_TOKENS[prompt],
    });
    const valid = new Set(evidence.map((e) => e.id));
    const cited =
      "cited" in output ? output.cited.map((c) => c.replace(/[[\]\s]/g, "")).filter((c) => valid.has(c)) : [];
    const confidence = Math.min(1, Math.max(0, output.confidence));
    const rawLabel =
      prompt === "single_agent" && output.label !== "NOT_ENOUGH_INFO" && cited.length === 0
        ? "NOT_ENOUGH_INFO"
        : output.label;
    const abstained = confidence < ctx.config.pipeline.abstainThreshold;
    const verdict = {
      claimId: claim.id,
      label: abstained ? ("NOT_ENOUGH_INFO" as const) : rawLabel,
      rawLabel,
      confidence,
      abstained,
      rationale: output.rationale,
      cited,
      samples: [output.label],
    };
    await ctx.ports.sink.emit({ type: "verdict", data: verdict });
    return { type: "verdict", claimId: claim.id, verdict };
  },
});

const aggregateStep: Step = {
  name: "aggregate",
  kind: "pure",
  run: () => Promise.resolve({ type: "done" }),
};

// ── planner ───────────────────────────────────────────────────────────────────────────────────────

function claimFrontier(claim: Claim, cs: ClaimState, state: RunState, cfg: SatyaConfig): Step[] {
  const v = state.variant;
  if (v.evidence === "tools") {
    if (!cs.plan) return [planStep(claim)];
    const searches = planSearches(claim.id, cs.plan, state.sources, cfg.tools.enabled);
    const pendingSearches = searches.filter((s) => !cs.tools[s.step]);
    if (pendingSearches.length) return pendingSearches.map((s) => toolStep(claim, s));
    const fetches = planFetches(
      claim.id,
      searches.map((s) => cs.tools[s.step]!),
      cfg.tools.enabled,
    );
    const pendingFetches = fetches.filter((f) => !cs.tools[f.step]);
    if (pendingFetches.length) return pendingFetches.map((f) => toolStep(claim, f));
  }
  if (v.evidence !== "none") {
    if (!cs.candidates) return [embedStep(claim)];
    if (!cs.evidence) return [rerankStep(claim)];
  }
  if (v.verdict !== "judge") return [baselineStep(claim, v.verdict)];
  const turns = Array.from({ length: v.debateRounds }, (_, r) =>
    SIDES.map((side) => [r + 1, side] as const),
  ).flat();
  const next = turns[cs.debate.length];
  if (next) return [argueStep(claim, next[0], next[1])];
  const pendingSamples = Array.from({ length: v.judgeSamples }, (_, i) => i + 1).filter(
    (i) => !cs.samples[i],
  );
  if (pendingSamples.length) return pendingSamples.map((i) => judgeStep(claim, i));
  return [verdictStep(claim)];
}

/**
 * The next runnable steps. At most `parallelClaims` unfinished claims are in flight (§7 M5); a claim is
 * finished once it has a verdict. Order: claims in input order, steps in pipeline order.
 */
export function planSteps(state: RunState, cfg: SatyaConfig): Step[] {
  if (state.done) return [];
  if (state.claims === null) return [decomposeStep];
  const open = checkable(state).filter((c) => !state.perClaim[c.id]?.verdict);
  if (open.length === 0) return [aggregateStep];
  return open
    .slice(0, cfg.pipeline.parallelClaims)
    .flatMap((c) => claimFrontier(c, state.perClaim[c.id] as ClaimState, state, cfg));
}

/**
 * Total for "step n of ~N": exact counts where already known (planned searches, planned fetches),
 * estimates otherwise (queriesPerClaim × sources; WIKI_PAGES/WEB_FETCHES per claim).
 */
export function estimateTotalSteps(state: RunState, cfg: SatyaConfig): number {
  const v = state.variant;
  const has = (s: SourceChoice) => (state.sources.includes(s) ? 1 : 0);
  const verdictSteps = v.verdict === "judge" ? 2 * v.debateRounds + v.judgeSamples + 1 : 1;
  const evidenceSteps = v.evidence === "none" ? 0 : 2;

  const toolSteps = (claim: Claim | null): number => {
    if (v.evidence !== "tools") return 0;
    const cs = claim ? state.perClaim[claim.id] : undefined;
    if (!cs?.plan) {
      const searches = cfg.pipeline.queriesPerClaim * (has("wikipedia") + has("web"));
      return 1 + searches + WIKI_PAGES_PER_CLAIM * has("wikipedia") + WEB_FETCHES_PER_CLAIM * has("web");
    }
    const searches = planSearches(claim!.id, cs.plan, state.sources, cfg.tools.enabled);
    const fetches = searches.every((s) => cs.tools[s.step])
      ? planFetches(
          claim!.id,
          searches.map((s) => cs.tools[s.step]!),
          cfg.tools.enabled,
        ).length
      : WIKI_PAGES_PER_CLAIM * has("wikipedia") + WEB_FETCHES_PER_CLAIM * has("web");
    return 1 + searches.length + fetches;
  };

  if (state.claims === null) {
    const claims = Math.min(state.maxClaims, Math.max(1, countSentences(state.inputText)));
    return (v.decompose ? 1 : 0) + claims * (toolSteps(null) + evidenceSteps + verdictSteps) + 1;
  }
  const perClaim = checkable(state).reduce((n, c) => n + toolSteps(c) + evidenceSteps + verdictSteps, 0);
  return (v.decompose ? 1 : 0) + perClaim + 1;
}

/** Sentence count, used before decomposition (also the cloud's claim estimate, C14). */
export function countSentences(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/).filter((s) => s.trim().length > 0).length;
}
