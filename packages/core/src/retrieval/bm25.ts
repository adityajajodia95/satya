// Okapi BM25 (k1 = 1.5, b = 0.75) with lowercase Unicode-aware tokenisation and English stop words.

export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below " +
    "between both but by can could did do does doing down during each few for from further had has have " +
    "having he her here hers herself him himself his how i if in into is it its itself just me more most " +
    "my myself no nor not now of off on once only or other our ours ourselves out over own same she should " +
    "so some such than that the their theirs them themselves then there these they this those through to " +
    "too under until up very was we were what when where which while who whom why will with would you " +
    "your yours yourself yourselves"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP_WORDS.has(t));
}

export interface Bm25Options {
  k1: number;
  b: number;
}

export class Bm25Index {
  private readonly docs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(
    texts: readonly string[],
    private readonly opts: Bm25Options = { k1: 1.5, b: 0.75 },
  ) {
    this.docs = texts.map((text) => {
      const tf = new Map<string, number>();
      for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.docs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  get size(): number {
    return this.docs.length;
  }

  /** Lucene-style non-negative IDF: ln(1 + (N − df + 0.5) / (df + 0.5)). */
  idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  scores(query: string): number[] {
    const terms = [...new Set(tokenize(query))];
    const { k1, b } = this.opts;
    return this.docs.map((tf, i) => {
      const norm = k1 * (1 - b + (b * (this.lengths[i] ?? 0)) / (this.avgLength || 1));
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term);
        if (f) score += (this.idf(term) * f * (k1 + 1)) / (f + norm);
      }
      return score;
    });
  }

  /** Indices of the top-k documents with a positive score, best first (ties keep input order). */
  topK(query: string, k: number): number[] {
    const scores = this.scores(query);
    return rankIndices(scores, k).filter((i) => (scores[i] ?? 0) > 0);
  }
}

/** Indices sorted by score descending (stable), truncated to k. */
export function rankIndices(scores: readonly number[], k: number): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map((s) => s.index);
}
