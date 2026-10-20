import { rankIndices } from "./bm25";

/** Returns a unit-length copy (zero vectors stay zero). */
export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Dot product; equals cosine similarity for normalised vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  return dot(normalize(a), normalize(b));
}

/** Indices of the k most similar (normalised) vectors to `query`, best first. */
export function topKByCosine(query: Float32Array, vectors: readonly Float32Array[], k: number): number[] {
  const q = normalize(query);
  return rankIndices(
    vectors.map((v) => dot(q, normalize(v))),
    k,
  );
}
