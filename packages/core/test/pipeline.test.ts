import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Bm25Index,
  PIPELINE_ERROR,
  SatyaConfig,
  applyPatch,
  buildReport,
  countSentences,
  estimateTotalSteps,
  initialState,
  planSteps,
  retrievalText,
  runLocal,
  variantFor,
  type Ports,
  type SourceChoice,
  type SystemName,
} from "../src/index";
import {
  FakeEmbedder,
  FakeLLM,
  FakeReranker,
  FakeTools,
  GOLDEN_STEPS,
  GOLDEN_TEXT,
  MemorySink,
  TINY_CORPUS,
  TickClock,
  goldenLlm,
} from "../src/testing/index";

const CONFIG = SatyaConfig.parse(
  JSON.parse(readFileSync(new URL("../../../configs/default.json", import.meta.url), "utf8")),
);

function ports(overrides: Partial<Ports> = {}): Ports & { sink: MemorySink } {
  return {
    llm: goldenLlm(),
    embedder: new FakeEmbedder(),
    reranker: new FakeReranker(),
    tools: new FakeTools(),
    sink: new MemorySink(),
    clock: new TickClock(),
    ...overrides,
  } as Ports & { sink: MemorySink };
}

const state = (
  text = GOLDEN_TEXT,
  system: SystemName = "satya_full",
  sources: SourceChoice[] = ["wikipedia"],
  decompose = true,
) =>
  initialState({
    runId: "r1",
    text,
    sources,
    maxClaims: 6,
    variant: variantFor(system, CONFIG, { decompose, evidence: "tools" }),
  });

describe("golden step sequence (executor parity, §6.2)", () => {
  it("runLocal walks exactly GOLDEN_STEPS for the fixed transcript", async () => {
    const p = ports();
    const { steps, state: final } = await runLocal(state(), { config: CONFIG, ports: p });
    expect(steps).toEqual(GOLDEN_STEPS);
    expect(final.perClaim.c1!.verdict).toMatchObject({
      label: "SUPPORTED",
      samples: ["SUPPORTED", "SUPPORTED", "SUPPORTED"],
      cited: ["E1"],
    });
    expect(final.perClaim.c2!.verdict).toMatchObject({
      label: "REFUTED",
      samples: ["REFUTED", "REFUTED", "REFUTED"],
    });
    expect(final.done).toBe(true);
  });

  it("emits events a UI can follow, and spans for every LLM call", async () => {
    const p = ports();
    await runLocal(state(), { config: CONFIG, ports: p });
    const types = p.sink.events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");
    expect(types.filter((t) => t === "verdict")).toHaveLength(2);
    expect(types.filter((t) => t === "argument")).toHaveLength(8);
    const stages = p.sink.events
      .filter((e) => e.type === "stage")
      .map((e) => e.data as { step: number; of: number });
    expect(stages.at(-1)).toEqual(expect.objectContaining({ step: 30, of: 30 }));
    expect(stages.every((s) => s.step <= s.of)).toBe(true);
    // 1 decompose + 2 plan + 8 argue + 6 judge LLM calls
    expect(p.sink.spans.map((s) => s.step.split(":")[0])).toEqual([
      "decompose",
      ...Array(2).fill("plan"),
      ...Array(8).fill("argue"),
      ...Array(6).fill("judge"),
    ]);
  });

  it("builds a report that matches the run", async () => {
    const p = ports();
    const { state: final } = await runLocal(state(), { config: CONFIG, ports: p });
    const report = buildReport(final, p.sink.spans, {
      model: "fake-llm",
      provider: "fake",
      createdAt: "2026-10-13T00:00:00Z",
      executor: "laptop",
    });
    expect(report.factuality).toBe(0.5);
    expect(Object.keys(report.verdicts)).toEqual(["c1", "c2"]);
    expect(report.evidence.c1![0]!.passage.title).toBe("Eiffel Tower");
    expect(report.debate.c2).toHaveLength(4);
    expect(report.partial).toBe(false);
    expect(report.claims[1]!.span).toEqual([40, 63]); // "It is located in Berlin"
  });
});

describe("failure handling (§7 M5)", () => {
  it("a forced tool failure still completes the run (no evidence → judge decides on nothing)", async () => {
    const llm = goldenLlm();
    const nei = new FakeLLM(
      { judge: { label: "NOT_ENOUGH_INFO", rationale: "No evidence.", cited: [] } },
      (req) => llm.chat(req).then((r) => JSON.parse(r.text)),
    );
    const p = ports({ llm: nei, tools: new FakeTools(new Set(["wiki_search", "wiki_page"])) });
    const { state: final, steps } = await runLocal(state(), { config: CONFIG, ports: p });
    expect(steps.at(-1)).toBe("aggregate");
    expect(steps).not.toContain("fetch:c1:1"); // nothing to fetch after failed searches
    expect(final.perClaim.c1!.evidence).toEqual([]);
    expect(final.perClaim.c1!.verdict!.label).toBe("NOT_ENOUGH_INFO");
    const toolEvents = p.sink.events
      .filter((e) => e.type === "tool_call")
      .map((e) => e.data as { ok: boolean });
    expect(toolEvents.every((e) => !e.ok)).toBe(true);
  });

  it("a claim whose step throws becomes NEI 'pipeline error'; other claims continue", async () => {
    const golden = goldenLlm();
    const llm = new FakeLLM({}, async (req) => {
      if (req.task === "skeptic" && /Berlin/.test(req.messages[0]!.content)) throw new Error("model crashed");
      return JSON.parse((await golden.chat(req)).text);
    });
    const p = ports({ llm });
    const { state: final, steps } = await runLocal(state(), { config: CONFIG, ports: p });
    expect(final.perClaim.c2!.verdict).toMatchObject({
      label: "NOT_ENOUGH_INFO",
      rationale: PIPELINE_ERROR,
      abstained: true,
    });
    expect(final.perClaim.c1!.verdict!.label).toBe("SUPPORTED");
    expect(steps).not.toContain("judge:c2:s1");
    expect(steps.at(-1)).toBe("aggregate");
  });

  it("a failed decomposition fails the run", async () => {
    const p = ports({ llm: new FakeLLM({ decomposer: "not json" }) });
    await expect(runLocal(state(), { config: CONFIG, ports: p })).rejects.toThrow(/decomposer/);
    expect(p.sink.events.at(-1)!.type).toBe("run_failed");
  });

  it("capacity mid-run marks remaining claims 'capacity' and the run partial", () => {
    let s = state();
    s = applyPatch(s, {
      type: "claims",
      claims: [
        { id: "c1", text: "a", quote: "a", span: null, checkworthy: true },
        { id: "c2", text: "b", quote: "b", span: null, checkworthy: true },
      ],
    });
    s = applyPatch(s, { type: "capacity", claimIds: ["c2"] });
    expect(s.partial).toBe(true);
    expect(s.perClaim.c2!.verdict).toMatchObject({ label: "NOT_ENOUGH_INFO", rationale: "capacity" });
    expect(planSteps(s, CONFIG).map((x) => x.name)).toEqual(["plan:c1"]);
  });
});

describe("scheduling", () => {
  it("keeps at most parallelClaims (2) claims in flight", () => {
    let s = state();
    const claims = ["a", "b", "c"].map((t, i) => ({
      id: `c${i + 1}`,
      text: t,
      quote: t,
      span: null,
      checkworthy: true,
    }));
    s = applyPatch(s, { type: "claims", claims });
    expect(planSteps(s, CONFIG).map((x) => x.name)).toEqual(["plan:c1", "plan:c2"]);
    s = applyPatch(s, { type: "capacity", claimIds: ["c1"] });
    expect(planSteps(s, CONFIG).map((x) => x.name)).toEqual(["plan:c2", "plan:c3"]);
  });

  it("skips non-check-worthy claims", () => {
    const s = applyPatch(state(), {
      type: "claims",
      claims: [{ id: "c1", text: "I love it", quote: "I love it", span: null, checkworthy: false }],
    });
    expect(planSteps(s, CONFIG).map((x) => x.name)).toEqual(["aggregate"]);
  });

  it("estimates total steps and counts sentences", () => {
    expect(countSentences("The Eiffel Tower was completed in 1889. It is in Berlin! Is it? yes")).toBe(3);
    expect(estimateTotalSteps(state(), CONFIG)).toBe(1 + 2 * (1 + 3 + 3 + 2 + 4 + 3 + 1) + 1);
  });
});

describe("evaluation variants run through the same steps", () => {
  const claimState = (system: SystemName) =>
    state("The Eiffel Tower was completed in 1889.", system, ["wikipedia"], false);

  it("llm_only: one call, no evidence", async () => {
    const llm = new FakeLLM({ llm_only: { label: "SUPPORTED", rationale: "Known fact.", confidence: 0.9 } });
    const { steps, state: final } = await runLocal(claimState("llm_only"), {
      config: CONFIG,
      ports: ports({ llm }),
    });
    expect(steps).toEqual(["judge:c1:s1", "aggregate"]);
    expect(final.perClaim.c1!.verdict).toMatchObject({
      label: "SUPPORTED",
      confidence: 0.9,
      abstained: false,
    });
  });

  it("single_agent_rag: retrieve then one judge call; uncited verdict → NEI; low verbal confidence abstains", async () => {
    const llm = new FakeLLM({
      planner: { queries: ["Eiffel Tower completed"], scientific: false },
      single_agent: [{ label: "SUPPORTED", rationale: "x", cited: [], confidence: 0.95 }],
    });
    const { steps, state: final } = await runLocal(claimState("single_agent_rag"), {
      config: CONFIG,
      ports: ports({ llm }),
    });
    expect(steps).toEqual([
      "plan:c1",
      "search:c1:q1:wiki",
      "fetch:c1:1",
      "embed:c1",
      "rerank:c1",
      "judge:c1:s1",
      "aggregate",
    ]);
    expect(final.perClaim.c1!.verdict).toMatchObject({ rawLabel: "NOT_ENOUGH_INFO" });
    const low = new FakeLLM({
      planner: { queries: ["Eiffel"], scientific: false },
      single_agent: { label: "SUPPORTED", rationale: "x", cited: ["E1"], confidence: 0.3 },
    });
    const r2 = await runLocal(claimState("single_agent_rag"), { config: CONFIG, ports: ports({ llm: low }) });
    expect(r2.state.perClaim.c1!.verdict).toMatchObject({
      label: "NOT_ENOUGH_INFO",
      rawLabel: "SUPPORTED",
      abstained: true,
    });
  });

  it("satya_no_debate has no argue steps; rounds_1 / rounds_3 change the debate length", async () => {
    for (const [system, argues] of [
      ["satya_no_debate", 0],
      ["rounds_1", 2],
      ["rounds_3", 6],
    ] as const) {
      const { steps } = await runLocal(claimState(system), { config: CONFIG, ports: ports() });
      expect(steps.filter((s) => s.startsWith("argue:"))).toHaveLength(argues);
    }
  });

  it("no_rerank never calls the re-ranker; dense_only uses no BM25 ranks", async () => {
    const reranker = new FakeReranker();
    const nr = await runLocal(claimState("no_rerank"), { config: CONFIG, ports: ports({ reranker }) });
    expect(reranker.calls).toHaveLength(0);
    expect(nr.state.perClaim.c1!.evidence!.every((e) => e.rerank === 0)).toBe(true);
    const dense = await runLocal(claimState("dense_only"), { config: CONFIG, ports: ports() });
    expect(dense.state.perClaim.c1!.evidence!.every((e) => e.bm25Rank === null)).toBe(true);
  });

  it("closed corpus: no planning or tools; retrieval runs over the corpus index", async () => {
    const tools = new FakeTools();
    const embedder = new FakeEmbedder();
    const corpus = {
      passages: TINY_CORPUS,
      vectors: await embedder.embed(TINY_CORPUS.map(retrievalText), "doc"),
      bm25: new Bm25Index(TINY_CORPUS.map(retrievalText)),
    };
    const s = initialState({
      runId: "r",
      text: "The Eiffel Tower was completed in 1889.",
      sources: [],
      maxClaims: 1,
      variant: variantFor("satya_full", CONFIG, { decompose: false, evidence: "corpus" }),
    });
    const { steps, state: final } = await runLocal(s, { config: CONFIG, ports: ports({ tools }), corpus });
    expect(steps.slice(0, 2)).toEqual(["embed:c1", "rerank:c1"]);
    expect(tools.calls).toHaveLength(0);
    expect(final.perClaim.c1!.evidence![0]!.passage.id).toBe("eiffel");
    expect(final.perClaim.c1!.verdict!.label).toBe("SUPPORTED");
  });
});
