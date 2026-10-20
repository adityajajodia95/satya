// Expected Calibration Error (equal-width bins) and the reliability-diagram data behind it.

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

/** Bin i covers (i/n, (i+1)/n]; confidence 0 falls in the first bin. */
export function reliabilityBins(
  confidence: readonly number[],
  correct: readonly boolean[],
  bins = 10,
): ReliabilityBin[] {
  if (confidence.length !== correct.length) throw new Error("confidence/correct length mismatch");
  const acc = Array.from({ length: bins }, () => ({ n: 0, conf: 0, hits: 0 }));
  confidence.forEach((c, i) => {
    const b = Math.min(bins - 1, Math.max(0, Math.ceil(c * bins) - 1));
    acc[b]!.n++;
    acc[b]!.conf += c;
    acc[b]!.hits += correct[i] ? 1 : 0;
  });
  return acc.map((a, i) => ({
    lower: i / bins,
    upper: (i + 1) / bins,
    count: a.n,
    meanConfidence: a.n ? a.conf / a.n : 0,
    accuracy: a.n ? a.hits / a.n : 0,
  }));
}

/** ECE = Σ_b (n_b / N) · |accuracy_b − confidence_b| (10 bins by default, §7 M7). */
export function expectedCalibrationError(
  confidence: readonly number[],
  correct: readonly boolean[],
  bins = 10,
): number {
  const n = confidence.length;
  if (n === 0) return 0;
  return reliabilityBins(confidence, correct, bins).reduce(
    (s, b) => s + (b.count / n) * Math.abs(b.accuracy - b.meanConfidence),
    0,
  );
}
