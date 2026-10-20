import { describe, expect, it } from "vitest";
import {
  type EvalItem,
  balancedSample,
  mulberry32,
  scifactLabel,
  seededShuffle,
  splitItems,
  toDatasetLabel,
} from "../src/eval/datasets";
import { renderSummary } from "../src/eval/report";
import { type ItemResult, bootstrapCI, downsample, finalLabel, summarize } from "../src/eval/summary";

const item = (id: number, gold: EvalItem["gold"]): EvalItem => ({
  id: `x:${id}`,
  dataset: "fever",
  claim: `c${id}`,
  gold,
});

describe("datasets", () => {
  it("SciFact claim label: SUPPORT → SUPPORTED, CONTRADICT → REFUTED, none → NEI", () => {
    expect(scifactLabel({ "1": [{ label: "SUPPORT" }] })).toBe("SUPPORTED");
    expect(scifactLabel({ "1": [{ label: "CONTRADICT" }], "2": [{ label: "CONTRADICT" }] })).toBe("REFUTED");
    expect(scifactLabel({})).toBe("NOT_ENOUGH_INFO");
  });

  it("seeded shuffle is deterministic and a permutation", () => {
    expect(mulberry32(13)()).toBe(mulberry32(13)());
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const a = seededShuffle(xs, 13);
    expect(a).toEqual(seededShuffle(xs, 13));
    expect(a).not.toEqual(xs);
    expect([...a].sort((p, q) => p - q)).toEqual(xs);
    expect(seededShuffle(xs, 14)).not.toEqual(a);
  });

  it("balanced sampling takes n per label", () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => item(i, "SUPPORTED")),
      ...Array.from({ length: 5 }, (_, i) => item(100 + i, "REFUTED")),
    ];
    const sample = balancedSample(pool, 4, 13);
    expect(sample.filter((s) => s.gold === "SUPPORTED")).toHaveLength(4);
    expect(sample.filter((s) => s.gold === "REFUTED")).toHaveLength(4);
    expect(() => balancedSample(pool, 6, 13)).toThrow(/only 5/);
  });

  it("30/70 split is stratified, disjoint and deterministic", () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => item(i, "SUPPORTED")),
      ...Array.from({ length: 10 }, (_, i) => item(100 + i, "REFUTED")),
    ];
    const { dev, test } = splitItems(pool);
    expect(dev.filter((d) => d.gold === "SUPPORTED")).toHaveLength(6);
    expect(dev.filter((d) => d.gold === "REFUTED")).toHaveLength(3);
    expect(test).toHaveLength(21);
    expect(dev.some((d) => test.includes(d))).toBe(false);
    expect(splitItems(pool)).toEqual({ dev, test });
  });

  it("HoVer maps REFUTED and NEI to NOT_SUPPORTED; other datasets keep the label", () => {
    expect(toDatasetLabel("hover", "REFUTED")).toBe("NOT_SUPPORTED");
    expect(toDatasetLabel("hover", "NOT_ENOUGH_INFO")).toBe("NOT_SUPPORTED");
    expect(toDatasetLabel("hover", "SUPPORTED")).toBe("SUPPORTED");
    expect(toDatasetLabel("scifact", "REFUTED")).toBe("REFUTED");
  });
});

const result = (
  id: string,
  gold: ItemResult["gold"],
  rawLabel: ItemResult["rawLabel"],
  confidence: number,
): ItemResult => ({
  id,
  gold,
  rawLabel,
  confidence,
  samples: [],
  cited: 1,
  passages: 5,
  ms: 2000,
  llmCalls: 8,
  repairs: 0,
  inTok: 1000,
  outTok: 200,
});

describe("summaries", () => {
  const items = [
    result("a", "SUPPORTED", "SUPPORTED", 0.9),
    result("b", "REFUTED", "REFUTED", 0.8),
    result("c", "NOT_ENOUGH_INFO", "SUPPORTED", 0.5), // abstains at τ 0.55 → NEI → correct
    result("d", "SUPPORTED", "REFUTED", 0.6),
  ];

  it("applies τ post hoc: below τ the final label is NOT_ENOUGH_INFO", () => {
    expect(finalLabel(items[2]!, 0.55)).toBe("NOT_ENOUGH_INFO");
    expect(finalLabel(items[2]!, 0.4)).toBe("SUPPORTED");
  });

  it("computes accuracy on final labels and calibration on raw labels", () => {
    const s = summarize(
      items,
      { dataset: "fever", system: "satya_full", split: "test", model: "qwen3:4b" },
      0.55,
    );
    expect(s.accuracy).toBe(0.75); // a, b, c correct after abstention
    expect(s.selective).toEqual({ tau: 0.55, coverage: 0.75, selectiveAccuracy: 2 / 3 });
    expect(s.confusion.matrix).toEqual([
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    // raw correctness [T, T, F, F] by confidence 0.9, 0.8, 0.6, 0.5 → risks 0, 0, 1/3, 1/2
    expect(s.aurc).toBeCloseTo((0 + 0 + 1 / 3 + 1 / 2) / 4, 12);
    expect(s.secondsPerClaim).toEqual({ mean: 2, median: 2 });
    expect(s.llmCallsPerClaim).toBe(8);
  });

  it("downsamples long curves to ≤ 101 points keeping both ends", () => {
    const pts = Array.from({ length: 777 }, (_, i) => i);
    const d = downsample(pts);
    expect(d).toHaveLength(101);
    expect([d[0], d.at(-1)]).toEqual([0, 776]);
  });

  it("the report shows '—' for missing systems and bolds the best value", () => {
    const s = summarize(
      items,
      { dataset: "scifact", system: "satya_full", split: "test", model: "qwen3:4b" },
      0.55,
    );
    const base = summarize(
      items.slice(0, 2),
      { dataset: "scifact", system: "llm_only", split: "test", model: "qwen3:4b" },
      0.55,
    );
    const md = renderSummary([s, base], null, "2026-10-13T00:00:00Z");
    const row = (name: string) => md.split("\n").find((l) => l.startsWith(`| ${name}`))!;
    expect(row("LLM-only")).toContain("| **100.0** |");
    expect(row("**Satya (Qwen3-4B, laptop)**")).toContain("| 75.0 |");
    expect(row("Single-agent RAG")).toBe("| Single-agent RAG (Qwen3-4B) | — | — | — | — | — | — | — |");
    expect(md).toContain("**Satya (gpt-oss-120b, deployed, 200-claim subset)** | — |");
  });
});

describe("bootstrap confidence interval", () => {
  const correct = Array.from({ length: 80 }, (_, i) => i < 49); // 61.25 % correct

  it("brackets the observed accuracy and is reproducible (seeded)", () => {
    const [lo, hi] = bootstrapCI(correct);
    expect(lo).toBeLessThan(0.6125);
    expect(hi).toBeGreaterThan(0.6125);
    expect(bootstrapCI(correct)).toEqual([lo, hi]);
    // n = 80 → roughly ±10 points at 95 %
    expect(hi - lo).toBeGreaterThan(0.15);
    expect(hi - lo).toBeLessThan(0.25);
  });

  it("narrows with more claims and is degenerate for all-correct or empty input", () => {
    const big = Array.from({ length: 800 }, (_, i) => i % 80 < 49);
    const [lo, hi] = bootstrapCI(big);
    const [slo, shi] = bootstrapCI(correct);
    expect(hi - lo).toBeLessThan(shi - slo);
    expect(bootstrapCI([true, true, true])).toEqual([1, 1]);
    expect(bootstrapCI([])).toEqual([0, 0]);
  });
});
