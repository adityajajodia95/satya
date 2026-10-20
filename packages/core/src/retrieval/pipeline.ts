// Hybrid retrieval (§7 M3): BM25 top-k ∪ dense top-k → RRF → top-`rerankTop` → cross-encoder → top-`finalK`.
// Split into two pure halves so the cloud Workflow can run them as separate steps (`embed:c1`,
// `rerank:c1`) while the laptop runs `retrieveEvidence`, which composes the same two functions.
import type { Embedder, Reranker } from "../ports";
import type { Evidence, Passage } from "../schemas";
import { Bm25Index } from "./bm25";
import { retrievalText } from "./chunker";
import { topKByCosine } from "./cosine";
import { rrf } from "./rrf";

export interface RetrievalConfig {
  bm25K: number;
  denseK: number;
  rrfK: number;
  rerankTop: number;
  finalK: number;
}

export interface Candidate {
  passage: Passage;
  bm25Rank: number | null;
  denseRank: number | null;
  rrf: number;
}

export interface FuseInput {
  query: string;
  passages: readonly Passage[];
  queryVector: Float32Array;
  passageVectors: readonly Float32Array[];
  /** Optional prebuilt BM25 index over `passages` (the SciFact corpus index is built once). */
  bm25?: Bm25Index;
}

/** BM25 top-k ∪ dense top-k fused by RRF; returns at most `rerankTop` candidates, best first. */
export function fuseCandidates(input: FuseInput, cfg: RetrievalConfig): Candidate[] {
  const { query, passages, queryVector, passageVectors } = input;
  if (passages.length !== passageVectors.length) {
    throw new Error(`got ${passageVectors.length} vectors for ${passages.length} passages`);
  }
  const bm25 = input.bm25 ?? new Bm25Index(passages.map(retrievalText));
  const lexical = bm25.topK(query, cfg.bm25K);
  const dense = topKByCosine(queryVector, passageVectors, cfg.denseK);
  const ids = (indices: number[]) => indices.map((i) => String(i));
  const fused = rrf([ids(lexical), ids(dense)], cfg.rrfK).slice(0, cfg.rerankTop);
  return fused.map(({ id, score }) => {
    const index = Number(id);
    const rankIn = (list: number[]) => (list.includes(index) ? list.indexOf(index) + 1 : null);
    return {
      passage: passages[index] as Passage,
      bm25Rank: rankIn(lexical),
      denseRank: rankIn(dense),
      rrf: score,
    };
  });
}

/** Orders candidates by re-rank score (ties: RRF) and labels the top `finalK` as E1..En. */
export function selectEvidence(
  candidates: readonly Candidate[],
  rerankScores: readonly number[],
  cfg: RetrievalConfig,
): Evidence[] {
  if (candidates.length !== rerankScores.length) {
    throw new Error(`got ${rerankScores.length} re-rank scores for ${candidates.length} candidates`);
  }
  return candidates
    .map((c, i) => ({ ...c, rerank: rerankScores[i] as number }))
    .sort((a, b) => b.rerank - a.rerank || b.rrf - a.rrf)
    .slice(0, cfg.finalK)
    .map((c, i) => ({ id: `E${i + 1}`, ...c }));
}

export interface RetrievalPorts {
  embedder: Embedder;
  reranker: Reranker;
}

/** Laptop composition of the two halves (the Workflow calls them as separate steps). */
export async function retrieveEvidence(
  query: string,
  passages: readonly Passage[],
  ports: RetrievalPorts,
  cfg: RetrievalConfig,
  opts: { passageVectors?: readonly Float32Array[]; bm25?: Bm25Index } = {},
): Promise<Evidence[]> {
  if (passages.length === 0) return [];
  const [queryVector] = await ports.embedder.embed([query], "query");
  const passageVectors =
    opts.passageVectors ?? (await ports.embedder.embed(passages.map(retrievalText), "doc"));
  const candidates = fuseCandidates(
    {
      query,
      passages,
      queryVector: queryVector as Float32Array,
      passageVectors,
      ...(opts.bm25 ? { bm25: opts.bm25 } : {}),
    },
    cfg,
  );
  const scores = await ports.reranker.score(
    query,
    candidates.map((c) => retrievalText(c.passage)),
  );
  return selectEvidence(candidates, scores, cfg);
}
