// Per-run metrics from stored item results. τ is applied post hoc (label = NEI when confidence < τ), so
// tuning τ never requires re-running the models.
import {
  type Label,
  type ReliabilityBin,
  type RiskCoveragePoint,
  accuracy,
  aurc,
  confusionMatrix,
  expectedCalibrationError,
  macroF1,
  reliabilityBins,
  riskCoverageCurve,
  selectiveAt,
} from "@satya/core";
import { type DatasetName, type GoldLabel, LABELS, toDatasetLabel } from "./datasets";

/** One evaluated claim. Only ids, labels and numbers — no dataset text is stored (C17). */
export interface ItemResult {
  id: string;
  gold: GoldLabel;
  rawLabel: Label;
  confidence: number;
  samples: Label[];
  cited: number;
  passages: number;
  ms: number;
  llmCalls: number;
  repairs: number;
  inTok: number;
  outTok: number;
  error?: string;
}

export interface RunSummary {
  dataset: DatasetName;
  system: string;
  split: string;
  model: string;
  tau: number;
  n: number;
  /** Set when the run covers a sample of the split: n of `of` claims (the same claims for every system). */
  sample?: { n: number; of: number };
  accuracy: number;
  /** 95 % percentile-bootstrap interval of accuracy (2,000 resamples, seeded — reproducible). */
  accuracyCI: [number, number];
  macroF1: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  confusion: { labels: readonly string[]; matrix: number[][] };
  ece: number;
  aurc: number;
  selective: { tau: number; coverage: number; selectiveAccuracy: number };
  reliability: ReliabilityBin[];
  riskCoverage: RiskCoveragePoint[];
  secondsPerClaim: { mean: number; median: number };
  llmCallsPerClaim: number;
  tokensPerClaim: { input: number; output: number };
  repairsPerClaim: number;
  errors: number;
}

export const finalLabel = (r: Pick<ItemResult, "rawLabel" | "confidence">, tau: number): Label =>
  r.confidence < tau ? "NOT_ENOUGH_INFO" : r.rawLabel;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]!
      : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
    : 0;
};
/** Seeded PRNG (mulberry32) so bootstrap intervals are identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for a proportion (e.g. accuracy from per-claim correctness). */
export function bootstrapCI(
  correct: readonly boolean[],
  resamples = 2000,
  level = 0.95,
  seed = 13,
): [number, number] {
  const n = correct.length;
  if (n === 0) return [0, 0];
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let hits = 0;
    for (let i = 0; i < n; i++) if (correct[Math.floor(rand() * n)]) hits++;
    stats.push(hits / n);
  }
  stats.sort((x, y) => x - y);
  const lo = stats[Math.floor(((1 - level) / 2) * resamples)]!;
  const hi = stats[Math.min(resamples - 1, Math.ceil((1 - (1 - level) / 2) * resamples) - 1)]!;
  return [lo, hi];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Keeps at most `max` evenly spaced points (always including the last) for charts. */
export function downsample<T>(points: readonly T[], max = 101): T[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as T);
}

export function summarize(
  items: readonly ItemResult[],
  meta: { dataset: DatasetName; system: string; split: string; model: string },
  tau: number,
): RunSummary {
  const labels = LABELS[meta.dataset];
  const gold = items.map((r) => r.gold);
  const pred = items.map((r) => toDatasetLabel(meta.dataset, finalLabel(r, tau)));
  const rawCorrect = items.map((r) => toDatasetLabel(meta.dataset, r.rawLabel) === r.gold);
  const confidence = items.map((r) => r.confidence);
  const f1 = macroF1(gold, pred, labels);
  const sel = selectiveAt(confidence, rawCorrect, tau);
  return {
    ...meta,
    tau,
    n: items.length,
    accuracy: accuracy(gold, pred),
    accuracyCI: bootstrapCI(gold.map((g, i) => g === pred[i])),
    macroF1: f1.macroF1,
    perClass: f1.perClass,
    confusion: { labels, matrix: confusionMatrix(gold, pred, labels) },
    ece: expectedCalibrationError(confidence, rawCorrect),
    aurc: aurc(confidence, rawCorrect),
    selective: { tau, coverage: sel.coverage, selectiveAccuracy: sel.selectiveAccuracy },
    reliability: reliabilityBins(confidence, rawCorrect),
    riskCoverage: downsample(riskCoverageCurve(confidence, rawCorrect)),
    secondsPerClaim: {
      mean: mean(items.map((r) => r.ms / 1000)),
      median: median(items.map((r) => r.ms / 1000)),
    },
    llmCallsPerClaim: mean(items.map((r) => r.llmCalls)),
    tokensPerClaim: { input: mean(items.map((r) => r.inTok)), output: mean(items.map((r) => r.outTok)) },
    repairsPerClaim: mean(items.map((r) => r.repairs)),
    errors: items.filter((r) => r.error).length,
  };
}
