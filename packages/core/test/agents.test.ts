import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentError,
  REPAIR_MESSAGE,
  SatyaConfig,
  aggregateSamples,
  argue,
  callJson,
  citedIds,
  collectPassages,
  decompose,
  dedupeDocsByUrl,
  extractJson,
  factuality,
  judgeSample,
  locateQuote,
  majority,
  plan,
  planFetches,
  planSearches,
  sigmoid,
  type AgentContext,
  type Evidence,
  type ToolDoc,
  type ToolResult,
  type Verdict,
} from "../src/index";
import { FakeLLM, MemorySink, TickClock, TINY_CORPUS } from "../src/testing/index";

const CONFIG = SatyaConfig.parse(
  JSON.parse(readFileSync(new URL("../../../configs/default.json", import.meta.url), "utf8")),
);
const ctx = (llm: FakeLLM, step = "test"): AgentContext & { sink: MemorySink } => ({
  llm,
  sink: new MemorySink(),
  clock: new TickClock(),
  step,
});

const evidence: Evidence[] = TINY_CORPUS.slice(0, 5).map((passage, i) => ({
  id: `E${i + 1}`,
  passage,
  bm25Rank: i + 1,
  denseRank: i + 1,
  rrf: 1 / (61 + i),
  rerank: [3, 1.0133, -1, 0.5, -2][i]!,
}));

describe("callJson", () => {
  it("extracts JSON from fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(extractJson("no json")).toBeUndefined();
  });

  it("passes the prompt's JSON schema and records a span", async () => {
    const llm = new FakeLLM({ planner: { queries: ["q"], scientific: false } });
    const c = ctx(llm, "plan:c1");
    await callJson(c, "planner", { claim: "x" }, { temperature: 0.2, reasoning: "low", maxTokens: 100 });
    expect(llm.calls[0]!.jsonSchema).toMatchObject({ required: ["queries", "scientific"] });
    expect(c.sink.spans).toEqual([
      expect.objectContaining({ step: "plan:c1", model: "fake-llm", provider: "fake", ok: true, ms: 10 }),
    ]);
  });

  it("repairs invalid output exactly once", async () => {
    const llm = new FakeLLM({ planner: ["not json", { queries: ["q"], scientific: true }] });
    const c = ctx(llm, "plan:c1");
    const { output } = await callJson(
      c,
      "planner",
      { claim: "x" },
      { temperature: 0.2, reasoning: "low", maxTokens: 100 },
    );
    expect(output.scientific).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages.at(-2)).toEqual({ role: "assistant", content: "not json" });
    expect(llm.calls[1]!.messages.at(-1)).toEqual({ role: "user", content: REPAIR_MESSAGE });
    expect(c.sink.spans.map((s) => [s.step, s.ok])).toEqual([
      ["plan:c1", false],
      ["plan:c1:repair", true],
    ]);
  });

  it("fails with bad_output after the repair attempt", async () => {
    const llm = new FakeLLM({ judge: { label: "TRUE", rationale: "x", cited: [] } });
    const call = callJson(
      ctx(llm),
      "judge",
      { claim: "c", evidence: "e", transcript: "t" },
      { temperature: 0.7, reasoning: "medium", maxTokens: 10 },
    );
    await expect(call).rejects.toBeInstanceOf(AgentError);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("locateQuote", () => {
  const text = "The Eiffel Tower was completed in 1889. It is located in Berlin, Germany.";
  it("finds exact and case-insensitive quotes", () => {
    expect(locateQuote(text, "completed in 1889")).toEqual([21, 38]);
    expect(locateQuote(text, "it is located in berlin")).toEqual([40, 63]);
  });
  it("fuzzy-matches a slightly altered quote (token Levenshtein ≥ 0.85)", () => {
    // 1 substitution in 7 tokens → similarity 6/7 = 0.857
    const span = locateQuote(text, "The Eiffel Tower was finished in 1889");
    expect(span).not.toBeNull();
    expect(text.slice(...span!)).toBe("The Eiffel Tower was completed in 1889");
  });
  it("returns null when nothing is similar enough", () => {
    expect(locateQuote(text, "Mount Everest is tall")).toBeNull();
    expect(locateQuote(text, "")).toBeNull();
  });
});

describe("decompose", () => {
  it("assigns ids, locates spans and caps check-worthy claims", async () => {
    const text = "The Eiffel Tower was completed in 1889. It is in Berlin. I love it. Paris is in France.";
    const llm = new FakeLLM({
      decomposer: {
        claims: [
          {
            text: "The Eiffel Tower was completed in 1889.",
            quote: "The Eiffel Tower was completed in 1889",
            checkworthy: true,
          },
          { text: "The Eiffel Tower is in Berlin.", quote: "It is in Berlin", checkworthy: true },
          { text: "The author loves the Eiffel Tower.", quote: "I love it", checkworthy: false },
          { text: "Paris is in France.", quote: "Paris is in France", checkworthy: true },
        ],
      },
    });
    const claims = await decompose(ctx(llm, "decompose"), text, CONFIG, 2);
    expect(claims.map((c) => [c.id, c.checkworthy])).toEqual([
      ["c1", true],
      ["c2", true],
      ["c3", false],
    ]);
    expect(text.slice(...claims[1]!.span!)).toBe("It is in Berlin");
  });
});

describe("plan", () => {
  it("trims, de-duplicates and caps queries; falls back to the claim", async () => {
    const llm = new FakeLLM({
      planner: {
        queries: [" Eiffel Tower 1889 ", "eiffel tower 1889", "When was it built?", "4th"],
        scientific: false,
      },
    });
    expect(await plan(ctx(llm), "claim", CONFIG)).toEqual({
      queries: ["Eiffel Tower 1889", "When was it built?", "4th"],
      scientific: false,
    });
    const echoed = new FakeLLM({
      planner: {
        queries: ["Is Eiffel Tower in Berlin scientific=true", "key entities: penicillin Fleming 1928"],
        scientific: false,
      },
    });
    expect((await plan(ctx(echoed), "c", CONFIG)).queries).toEqual([
      "Is Eiffel Tower in Berlin",
      "penicillin Fleming 1928",
    ]);
    const empty = new FakeLLM({ planner: { queries: ["  "], scientific: true } });
    expect(await plan(ctx(empty), "The claim.", CONFIG)).toEqual({
      queries: ["The claim."],
      scientific: true,
    });
  });
});

describe("researcher planning", () => {
  const enabled = CONFIG.tools.enabled;

  it("plans one search per query × source; papers only for scientific claims", () => {
    const steps = planSearches(
      "c1",
      { queries: ["a", "b"], scientific: false },
      ["wikipedia", "web", "papers"],
      enabled,
    );
    expect(steps.map((s) => s.step)).toEqual([
      "search:c1:q1:wiki",
      "search:c1:q1:web",
      "search:c1:q2:wiki",
      "search:c1:q2:web",
    ]);
    const sci = planSearches("c2", { queries: ["a"], scientific: true }, ["papers"], enabled);
    expect(sci.map((s) => [s.step, s.tool])).toEqual([
      ["search:c2:q1:arxiv", "arxiv_search"],
      ["search:c2:q1:scholar", "scholar_search"],
    ]);
    expect(planSearches("c3", { queries: ["a"], scientific: true }, ["wikipedia"], ["wiki_page"])).toEqual(
      [],
    );
  });

  const doc = (source: ToolDoc["source"], title: string, url: string, text = "t"): ToolDoc => ({
    source,
    title,
    url,
    text,
    published: null,
  });
  const ok = (tool: ToolResult["tool"], docs: ToolDoc[]): ToolResult => ({
    ok: true,
    tool,
    docs,
    cached: false,
  });

  it("fetches top Wikipedia titles round-robin and top web pages (skipping Wikipedia URLs)", () => {
    const searches: ToolResult[] = [
      ok("wiki_search", [
        doc("wikipedia", "A", "https://en.wikipedia.org/wiki/A"),
        doc("wikipedia", "B", "https://en.wikipedia.org/wiki/B"),
      ]),
      ok("wiki_search", [
        doc("wikipedia", "C", "https://en.wikipedia.org/wiki/C"),
        doc("wikipedia", "A", "https://en.wikipedia.org/wiki/A"),
      ]),
      ok("web_search", [
        doc("web", "W1", "https://en.wikipedia.org/wiki/A"),
        doc("web", "W2", "https://x.org/2"),
        doc("web", "W3", "https://y.org/3"),
      ]),
      { ok: false, tool: "web_search", error: { code: "rate_limited", message: "429" } },
    ];
    const fetches = planFetches("c1", searches, enabled);
    expect(fetches).toEqual([
      { step: "fetch:c1:1", tool: "wiki_page", args: { title: "A" } },
      { step: "fetch:c1:2", tool: "wiki_page", args: { title: "C" } },
      { step: "fetch:c1:3", tool: "wiki_page", args: { title: "B" } },
      { step: "fetch:c1:4", tool: "fetch_url", args: { url: "https://x.org/2" } },
      { step: "fetch:c1:5", tool: "fetch_url", args: { url: "https://y.org/3" } },
    ]);
  });

  it("keeps the longest text per URL and caps passages with a BM25 pre-filter", () => {
    const deduped = dedupeDocsByUrl([
      doc("wikipedia", "A", "u", "snippet"),
      doc("wikipedia", "A", "u", "full page text"),
    ]);
    expect(deduped.map((d) => d.text)).toEqual(["full page text"]);
    const filler = Array.from({ length: 30 }, (_, i) =>
      doc("web", `F${i}`, `https://f.org/${i}`, `unrelated filler text number ${i} `.repeat(60)),
    );
    const target = doc(
      "web",
      "T",
      "https://t.org",
      "lorem ".repeat(500) + " the eiffel tower was completed in 1889 " + "ipsum ".repeat(300),
    );
    const passages = collectPassages("Eiffel Tower completed 1889", [ok("fetch_url", [...filler, target])], {
      ...CONFIG,
      retrieval: { ...CONFIG.retrieval, maxPassages: 10 },
    });
    expect(passages).toHaveLength(10);
    expect(passages.some((p) => p.text.includes("eiffel tower was completed"))).toBe(true);
  });
});

describe("debaters", () => {
  it("collects valid citations from the list and inline [E#] mentions", () => {
    expect(citedIds("As [E3] and E1 show, …", ["[E2]", "e1", "E9"], evidence)).toEqual(["E1", "E2", "E3"]);
  });

  it("produces an Argument and sees the transcript", async () => {
    const llm = new FakeLLM({ skeptic: { argument: "E3 is about Berlin, not Paris [E3].", cited: [] } });
    const arg = await argue(
      ctx(llm, "argue:c1:r2:skeptic"),
      "skeptic",
      2,
      { id: "c1", text: "claim" },
      evidence,
      [{ claimId: "c1", side: "advocate", round: 1, text: "E1 supports it.", cited: ["E1"] }],
      CONFIG,
    );
    expect(arg).toEqual({
      claimId: "c1",
      side: "skeptic",
      round: 2,
      text: "E3 is about Berlin, not Paris [E3].",
      cited: ["E3"],
    });
    expect(llm.calls[0]!.messages[0]!.content).toContain("Round 1 ADVOCATE: E1 supports it.");
    expect(llm.calls[0]!.messages[0]!.content).toContain("[E1] (wikipedia, Eiffel Tower)");
  });
});

describe("judge", () => {
  const s = (label: "SUPPORTED" | "REFUTED" | "NOT_ENOUGH_INFO", cited: string[] = []) => ({
    label,
    rationale: `${label} because`,
    cited,
  });

  it("reproduces the spec example: 3× SUPPORTED → confidence 0.92", () => {
    // max re-rank of cited evidence E2 = 1.0133 → sigmoid = 0.7336 → 0.7·1 + 0.3·0.7336 = 0.920
    const v = aggregateSamples(
      "c1",
      [s("SUPPORTED", ["E2"]), s("SUPPORTED", ["E2"]), s("SUPPORTED", ["E2"])],
      evidence,
      0.55,
    );
    expect(v.label).toBe("SUPPORTED");
    expect(v.confidence).toBeCloseTo(0.92, 2);
    expect(v.abstained).toBe(false);
  });

  it("uses the max re-rank among evidence cited by the majority samples", () => {
    const v = aggregateSamples(
      "c1",
      [s("REFUTED", ["E4"]), s("REFUTED", ["E1"]), s("SUPPORTED", ["E5"])],
      evidence,
      0.55,
    );
    expect(v.label).toBe("REFUTED");
    expect(v.cited).toEqual(["E1", "E4"]);
    expect(v.confidence).toBeCloseTo(0.7 * (2 / 3) + 0.3 * sigmoid(3), 10);
    expect(v.samples).toEqual(["REFUTED", "REFUTED", "SUPPORTED"]);
  });

  it("turns an uncited SUPPORTED/REFUTED majority into NOT_ENOUGH_INFO", () => {
    const v = aggregateSamples("c1", [s("SUPPORTED"), s("SUPPORTED"), s("REFUTED", ["E1"])], evidence, 0.55);
    expect(v.rawLabel).toBe("NOT_ENOUGH_INFO");
    expect(v.label).toBe("NOT_ENOUGH_INFO");
  });

  it("abstains below τ and keeps the raw majority label", () => {
    // agreement 2/3, cited E3 (re-rank −1) → 0.4667 + 0.3·0.2689 = 0.547 < 0.55
    const v = aggregateSamples(
      "c1",
      [s("SUPPORTED", ["E3"]), s("SUPPORTED", ["E3"]), s("REFUTED", ["E1"])],
      evidence,
      0.55,
    );
    expect(v.confidence).toBeCloseTo(0.5473, 4);
    expect(v).toMatchObject({ abstained: true, label: "NOT_ENOUGH_INFO", rawLabel: "SUPPORTED" });
  });

  it("breaks ties conservatively (NEI first)", () => {
    expect(majority(["SUPPORTED", "REFUTED", "NOT_ENOUGH_INFO"])).toBe("NOT_ENOUGH_INFO");
    expect(majority(["REFUTED", "SUPPORTED"])).toBe("REFUTED");
    expect(majority(["SUPPORTED", "SUPPORTED", "REFUTED"])).toBe("SUPPORTED");
  });

  it("samples use the judge temperature, judge reasoning and distinct seeds", async () => {
    const llm = new FakeLLM({ judge: { label: "SUPPORTED", rationale: "E1 states 1889 [E1]", cited: [] } });
    for (const i of [1, 2, 3])
      await judgeSample(ctx(llm, `judge:c1:s${i}`), "claim", evidence, [], i, CONFIG);
    expect(llm.calls.map((c) => [c.temperature, c.reasoning, c.seed])).toEqual([
      [0.7, "medium", 1],
      [0.7, "medium", 2],
      [0.7, "medium", 3],
    ]);
  });
});

describe("aggregator", () => {
  const v = (label: Verdict["label"]): Verdict => ({
    claimId: "c",
    label,
    rawLabel: label,
    confidence: 1,
    abstained: false,
    rationale: "",
    cited: [],
    samples: [],
  });
  it("factuality = supported / (supported + refuted)", () => {
    expect(
      factuality([v("SUPPORTED"), v("SUPPORTED"), v("SUPPORTED"), v("REFUTED"), v("NOT_ENOUGH_INFO")]),
    ).toBe(0.75);
    expect(factuality([v("NOT_ENOUGH_INFO")])).toBeNull();
  });
});
