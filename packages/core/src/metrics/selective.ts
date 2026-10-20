// Selective prediction: accuracy/coverage at a threshold, the risk–coverage curve and its area (AURC).

export interface SelectiveResult {
  coverage: number;
  selectiveAccuracy: number;
  answered: number;
}

/** Answer when confidence ≥ τ; selective accuracy is measured on answered items only. */
export function selectiveAt(
  confidence: readonly number[],
  correct: readonly boolean[],
  tau: number,
): SelectiveResult {
  const answered = confidence.map((c, i) => ({ c, ok: correct[i] })).filter((x) => x.c >= tau);
  return {
    coverage: confidence.length ? answered.length / confidence.length : 0,
    selectiveAccuracy: answered.length ? answered.filter((x) => x.ok).length / answered.length : 0,
    answered: answered.length,
  };
}

export interface RiskCoveragePoint {
  coverage: number;
  risk: number;
}

/**
 * Items sorted by confidence (descending; ties keep input order); point k = (k/N, error rate of the top k).
 */
export function riskCoverageCurve(
  confidence: readonly number[],
  correct: readonly boolean[],
): RiskCoveragePoint[] {
  const order = confidence
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .map((x) => x.i);
  let errors = 0;
  return order.map((i, k) => {
    if (!correct[i]) errors++;
    return { coverage: (k + 1) / order.length, risk: errors / (k + 1) };
  });
}

/** AURC = mean risk over all coverage levels k/N (lower is better). */
export function aurc(confidence: readonly number[], correct: readonly boolean[]): number {
  const curve = riskCoverageCurve(confidence, correct);
  return curve.length ? curve.reduce((s, p) => s + p.risk, 0) / curve.length : 0;
}

/**
 * τ tuning (§7 M7): the threshold maximising selective accuracy subject to coverage ≥ `minCoverage`.
 * Candidates are the observed confidences (plus 0); ties prefer the higher coverage, then the lower τ.
 */
export function tuneThreshold(
  confidence: readonly number[],
  correct: readonly boolean[],
  minCoverage = 0.7,
): { tau: number } & SelectiveResult {
  const candidates = [...new Set([0, ...confidence])].sort((a, b) => a - b);
  let best: ({ tau: number } & SelectiveResult) | null = null;
  for (const tau of candidates) {
    const r = selectiveAt(confidence, correct, tau);
    if (r.coverage < minCoverage) continue;
    if (
      !best ||
      r.selectiveAccuracy > best.selectiveAccuracy ||
      (r.selectiveAccuracy === best.selectiveAccuracy && r.coverage > best.coverage)
    ) {
      best = { tau, ...r };
    }
  }
  return best ?? { tau: 0, ...selectiveAt(confidence, correct, 0) };
}
