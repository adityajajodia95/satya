import { describe, expect, it } from "vitest";
import {
  accuracy,
  aurc,
  confusionMatrix,
  expectedCalibrationError,
  macroF1,
  reliabilityBins,
  riskCoverageCurve,
  selectiveAt,
  tuneThreshold,
} from "../src/index";

type L = "S" | "R" | "N";
const LABELS: L[] = ["S", "R", "N"];

describe("classification", () => {
  it("accuracy", () => {
    expect(accuracy(["S", "R", "S"], ["S", "S", "S"])).toBeCloseTo(2 / 3, 12);
    expect(accuracy([], [])).toBe(0);
    expect(() => accuracy(["S"], [])).toThrow();
  });

  it("confusion matrix rows = gold, columns = predicted", () => {
    expect(confusionMatrix<L>(["S", "S", "R", "N"], ["S", "R", "R", "N"], LABELS)).toEqual([
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it("macro-F1 matches a hand computation", () => {
    // S: P 1, R .5 → F .6667; R: P .5, R 1 → F .6667; N: F 1 → macro .7778
    const { macroF1: m, perClass } = macroF1<L>(["S", "S", "R", "N"], ["S", "R", "R", "N"], LABELS);
    expect(perClass.S).toMatchObject({ precision: 1, recall: 0.5, support: 2 });
    expect(perClass.R.f1).toBeCloseTo(2 / 3, 12);
    expect(m).toBeCloseTo((2 / 3 + 2 / 3 + 1) / 3, 12);
  });

  it("a never-predicted class scores 0 without NaN", () => {
    const { perClass, macroF1: m } = macroF1<L>(["S", "R"], ["S", "S"], LABELS);
    expect(perClass.R).toEqual({ precision: 0, recall: 0, f1: 0, support: 1 });
    expect(Number.isNaN(m)).toBe(false);
  });
});

describe("calibration", () => {
  const conf = [0.9, 0.9, 0.1, 0.6];
  const ok = [true, false, false, true];

  it("ECE (10 bins) matches a hand computation", () => {
    // bin (0.8,0.9]: |0.5 − 0.9|·2/4 = 0.2; bin (0,0.1]: |0 − 0.1|·1/4 = 0.025; bin (0.5,0.6]: |1 − 0.6|·1/4 = 0.1
    expect(expectedCalibrationError(conf, ok)).toBeCloseTo(0.325, 12);
  });

  it("reliability bins carry counts, mean confidence and accuracy", () => {
    const bins = reliabilityBins(conf, ok);
    expect(bins).toHaveLength(10);
    expect(bins[8]).toEqual({ lower: 0.8, upper: 0.9, count: 2, meanConfidence: 0.9, accuracy: 0.5 });
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(4);
    expect(reliabilityBins([0], [true])[0]!.count).toBe(1);
  });

  it("a perfectly calibrated set has ECE 0", () => {
    expect(expectedCalibrationError([1, 1, 1], [true, true, true])).toBe(0);
  });
});

describe("selective prediction", () => {
  const conf = [0.9, 0.8, 0.7, 0.6];
  const ok = [true, false, true, false];

  it("risk–coverage curve and AURC", () => {
    expect(riskCoverageCurve(conf, ok).map((p) => [p.coverage, Number(p.risk.toFixed(4))])).toEqual([
      [0.25, 0],
      [0.5, 0.5],
      [0.75, 0.3333],
      [1, 0.5],
    ]);
    expect(aurc(conf, ok)).toBeCloseTo((0 + 0.5 + 1 / 3 + 0.5) / 4, 12);
  });

  it("selective accuracy and coverage at τ", () => {
    expect(selectiveAt(conf, ok, 0.75)).toEqual({ coverage: 0.5, selectiveAccuracy: 0.5, answered: 2 });
    expect(selectiveAt(conf, ok, 0.95)).toEqual({ coverage: 0, selectiveAccuracy: 0, answered: 0 });
  });

  it("tunes τ for best selective accuracy with coverage ≥ the minimum", () => {
    expect(tuneThreshold(conf, ok, 0.5)).toMatchObject({ tau: 0.7, coverage: 0.75 });
    expect(tuneThreshold(conf, ok, 0.5).selectiveAccuracy).toBeCloseTo(2 / 3, 12);
    expect(tuneThreshold(conf, ok, 1).tau).toBe(0); // only full coverage qualifies
  });
});
