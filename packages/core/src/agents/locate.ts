// Finds where a claim's `quote` occurs in the input text (§7 M4): exact match first, then a token-level
// Levenshtein window with similarity ≥ 0.85. Returns character offsets [start, end) or null.

const MIN_SIMILARITY = 0.85;

interface Token {
  norm: string;
  start: number;
  end: number;
}

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’.,][\p{L}\p{N}]+)*/gu)].map((m) => ({
    norm: m[0].toLowerCase().replace(/’/g, "'"),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Levenshtein distance over token sequences. */
export function tokenDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function locateQuote(text: string, quote: string): [number, number] | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return [exact, exact + q.length];
  const ci = text.toLowerCase().indexOf(q.toLowerCase());
  if (ci >= 0) return [ci, ci + q.length];

  const textTokens = tokens(text);
  const quoteTokens = tokens(q).map((t) => t.norm);
  const m = quoteTokens.length;
  if (m === 0 || textTokens.length === 0) return null;
  let best: { similarity: number; start: number; end: number } | null = null;
  for (let width = Math.max(1, m - 2); width <= m + 2; width++) {
    for (let i = 0; i + width <= textTokens.length; i++) {
      const window = textTokens.slice(i, i + width);
      const similarity =
        1 -
        tokenDistance(
          window.map((t) => t.norm),
          quoteTokens,
        ) /
          Math.max(width, m);
      if (!best || similarity > best.similarity) {
        best = { similarity, start: window[0]!.start, end: window[width - 1]!.end };
      }
    }
  }
  return best && best.similarity >= MIN_SIMILARITY ? [best.start, best.end] : null;
}
