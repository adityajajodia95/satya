import type { Passage } from "../../src/schemas";
export declare const TINY_CORPUS: Passage[];
export declare const TINY_QUERIES: {
  query: string;
  expected: string;
}[];
export declare const RETRIEVAL_CONFIG: {
  bm25K: number;
  denseK: number;
  rrfK: number;
  rerankTop: number;
  finalK: number;
};
