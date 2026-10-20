/**
 * Reciprocal Rank Fusion: score(d) = Σ over lists of 1 / (k + rank(d)), rank starting at 1.
 * Returns ids sorted by fused score (ties: first appearance across lists).
 */
export function rrf(lists: readonly (readonly string[])[], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
