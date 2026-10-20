// Accuracy, confusion matrix and macro-F1 over an explicit label set.

export function accuracy<L extends string>(gold: readonly L[], pred: readonly L[]): number {
  if (gold.length !== pred.length) throw new Error("gold/pred length mismatch");
  if (gold.length === 0) return 0;
  return gold.filter((g, i) => g === pred[i]).length / gold.length;
}

/** matrix[goldIndex][predIndex] = count. */
export function confusionMatrix<L extends string>(
  gold: readonly L[],
  pred: readonly L[],
  labels: readonly L[],
): number[][] {
  const index = new Map(labels.map((l, i) => [l, i]));
  const m = labels.map(() => labels.map(() => 0));
  gold.forEach((g, i) => {
    const gi = index.get(g);
    const pi = index.get(pred[i] as L);
    if (gi === undefined || pi === undefined)
      throw new Error(`label outside the label set: ${g} / ${pred[i]}`);
    m[gi]![pi]!++;
  });
  return m;
}

export interface ClassScores {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

/** Per-class precision/recall/F1 (0 when undefined) and their unweighted mean (macro-F1). */
export function macroF1<L extends string>(
  gold: readonly L[],
  pred: readonly L[],
  labels: readonly L[],
): { macroF1: number; perClass: Record<L, ClassScores> } {
  const m = confusionMatrix(gold, pred, labels);
  const perClass = {} as Record<L, ClassScores>;
  labels.forEach((label, i) => {
    const tp = m[i]![i]!;
    const predicted = m.reduce((s, row) => s + row[i]!, 0);
    const actual = m[i]!.reduce((s, v) => s + v, 0);
    const precision = predicted ? tp / predicted : 0;
    const recall = actual ? tp / actual : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[label] = { precision, recall, f1, support: actual };
  });
  const macro = labels.reduce((s, l) => s + perClass[l].f1, 0) / labels.length;
  return { macroF1: macro, perClass };
}
