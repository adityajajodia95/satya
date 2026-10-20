import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Bm25Index, STOP_WORDS, rankIndices, tokenize } from "../src/retrieval/bm25";
import { chunkDoc, dedupePassages, retrievalText } from "../src/retrieval/chunker";
import { cosine, normalize, topKByCosine } from "../src/retrieval/cosine";
import { fuseCandidates, retrieveEvidence, selectEvidence } from "../src/retrieval/pipeline";
import { rrf } from "../src/retrieval/rrf";
import type { ToolDoc } from "../src/schemas";
import { sha1Hex } from "../src/util/sha1";
import { FakeEmbedder, FakeReranker } from "../src/testing/fakes";
import { RETRIEVAL_CONFIG, TINY_CORPUS, TINY_QUERIES } from "../src/testing/tiny-corpus";

describe("RRF", () => {
  it("matches a hand-computed example (k = 60, ranks start at 1)", () => {
    // a: 1/61 + 1/62, c: 1/63 + 1/61, b: 1/62, d: 1/63
    const fused = rrf(
      [
        ["a", "b", "c"],
        ["c", "a", "d"],
      ],
      60,
    );
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(0.0325224749, 9);
    expect(fused[1]!.score).toBeCloseTo(0.0322664585, 9);
    expect(fused[2]!.score).toBeCloseTo(1 / 62, 12);
    expect(fused[3]!.score).toBeCloseTo(1 / 63, 12);
  });

  it("an item in one list only gets that list's contribution", () => {
    expect(rrf([["x"], []], 60)).toEqual([{ id: "x", score: 1 / 61 }]);
  });
});

describe("BM25", () => {
  it("matches hand-computed Okapi scores (k1 1.5, b 0.75, Lucene idf)", () => {
    const index = new Bm25Index(["cat sat", "dog sat", "cat cat"]);
    // idf(cat) = ln(1 + (3 − 2 + .5)/(2 + .5)) = ln 1.6; avgdl = 2 → norm = 1.5
    const idf = Math.log(1.6);
    const [s0, s1, s2] = index.scores("cat");
    expect(s0).toBeCloseTo((idf * 1 * 2.5) / (1 + 1.5), 10);
    expect(s1).toBe(0);
    expect(s2).toBeCloseTo((idf * 2 * 2.5) / (2 + 1.5), 10);
    expect(index.topK("cat", 5)).toEqual([2, 0]); // zero-score docs are excluded
  });

  it("tokenises lowercase, Unicode-aware, without stop words", () => {
    expect(tokenize("The Café in São Paulo, 1889!")).toEqual(["café", "são", "paulo", "1889"]);
    expect(STOP_WORDS.has("the")).toBe(true);
  });

  it("rankIndices is stable for ties", () => {
    expect(rankIndices([1, 3, 3, 2], 3)).toEqual([1, 2, 3]);
  });
});

describe("cosine", () => {
  it("normalises and compares", () => {
    const a = new Float32Array([3, 4]);
    expect(Array.from(normalize(a))).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(cosine(a, new Float32Array([6, 8]))).toBeCloseTo(1, 6);
    expect(cosine(a, new Float32Array([-4, 3]))).toBeCloseTo(0, 6);
    expect(
      topKByCosine(
        new Float32Array([1, 0]),
        [new Float32Array([0, 1]), new Float32Array([1, 1]), new Float32Array([5, 0])],
        2,
      ),
    ).toEqual([2, 1]);
  });
});

describe("sha1", () => {
  it.each([
    ["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["The quick brown fox jumps over the lazy dog", "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "84983e441c3bd26ebaae4aa1f95129e5e54670f1"],
  ])("sha1(%j)", (input, hex) => {
    expect(sha1Hex(input)).toBe(hex);
  });

  it.each([
    "सत्य",
    "Café — São Paulo",
    "x".repeat(55),
    "y".repeat(56),
    "z".repeat(1000),
    "https://en.wikipedia.org/wiki/Eiffel_Tower#3",
  ])("agrees with node:crypto for %j", (input) => {
    expect(sha1Hex(input)).toBe(createHash("sha1").update(input, "utf8").digest("hex"));
  });
});

describe("chunker", () => {
  const doc = (words: number): ToolDoc => ({
    source: "web",
    url: "https://example.com/a",
    title: "Example",
    text: Array.from({ length: words }, (_, i) => `w${i}`).join(" "),
    published: null,
  });

  it("makes 220-word chunks with 40-word overlap", () => {
    const chunks = chunkDoc(doc(500), { chunkWords: 220, chunkOverlap: 40 });
    expect(chunks.map((c) => c.text.split(" ").length)).toEqual([220, 220, 140]);
    expect(chunks[1]!.text.split(" ")[0]).toBe("w180");
    expect(chunks[2]!.text.split(" ").at(-1)).toBe("w499");
  });

  it("short documents become one chunk; empty ones none", () => {
    expect(chunkDoc(doc(10), { chunkWords: 220, chunkOverlap: 40 })).toHaveLength(1);
    expect(chunkDoc({ ...doc(0), text: "  " }, { chunkWords: 220, chunkOverlap: 40 })).toHaveLength(0);
  });

  it("ids are sha1(url#index), stable and unique; dedupe keeps the first", () => {
    const chunks = chunkDoc(doc(500), { chunkWords: 220, chunkOverlap: 40 });
    expect(chunks[0]!.id).toBe(sha1Hex("https://example.com/a#0"));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
    expect(dedupePassages([...chunks, ...chunks])).toEqual(chunks);
  });

  it("retrieval text carries the title prefix", () => {
    expect(retrievalText(TINY_CORPUS[0]!)).toMatch(/^Eiffel Tower\nThe Eiffel Tower/);
  });
});

describe("hybrid pipeline", () => {
  it("records each candidate's BM25 and dense ranks and its RRF score", () => {
    const qv = new Float32Array([1, 0]);
    const vectors = [new Float32Array([0, 1]), new Float32Array([1, 0.1]), new Float32Array([0.5, 0.5])];
    const passages = TINY_CORPUS.slice(0, 3);
    const candidates = fuseCandidates(
      { query: "Eiffel Tower 1889", passages, queryVector: qv, passageVectors: vectors },
      RETRIEVAL_CONFIG,
    );
    const eiffel = candidates.find((c) => c.passage.id === "eiffel")!;
    expect(eiffel.bm25Rank).toBe(1);
    expect(eiffel.denseRank).toBe(3);
    expect(eiffel.rrf).toBeCloseTo(1 / 61 + 1 / 63, 12);
    const louvre = candidates.find((c) => c.passage.id === "louvre")!;
    expect(louvre).toMatchObject({ bm25Rank: null, denseRank: 1 });
  });

  it("selectEvidence orders by re-rank score and labels E1..E5", () => {
    const candidates = TINY_CORPUS.slice(0, 6).map((passage, i) => ({
      passage,
      bm25Rank: i + 1,
      denseRank: null,
      rrf: 1 / (61 + i),
    }));
    const evidence = selectEvidence(candidates, [0.1, 2, -1, 2, 0, 5], RETRIEVAL_CONFIG);
    expect(evidence.map((e) => [e.id, e.passage.id])).toEqual([
      ["E1", "penicillin"], // 5
      ["E2", "louvre"], // 2, tie with everest broken by RRF (1/62 > 1/64)
      ["E3", "everest"], // 2
      ["E4", "eiffel"], // 0.1
      ["E5", "water"], // 0 (brandenburg −1 is dropped)
    ]);
  });

  it.each(TINY_QUERIES)(
    "tiny corpus, fake cloud ports: '$query' → $expected first",
    async ({ query, expected }) => {
      const evidence = await retrieveEvidence(
        query,
        TINY_CORPUS,
        { embedder: new FakeEmbedder(), reranker: new FakeReranker() },
        RETRIEVAL_CONFIG,
      );
      expect(evidence[0]!.passage.id).toBe(expected);
      expect(evidence).toHaveLength(5);
      expect(evidence.map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    },
  );

  it("embeds the query as 'query' and passages as 'doc' (bge-m3: no instruction prefix)", async () => {
    const embedder = new FakeEmbedder();
    await retrieveEvidence(
      "Eiffel Tower",
      TINY_CORPUS,
      { embedder, reranker: new FakeReranker() },
      RETRIEVAL_CONFIG,
    );
    expect(embedder.calls.map((c) => c.kind)).toEqual(["query", "doc"]);
    expect(embedder.calls[0]!.texts).toEqual(["Eiffel Tower"]);
  });

  it("returns no evidence for no passages without calling models", async () => {
    const embedder = new FakeEmbedder();
    expect(
      await retrieveEvidence("x", [], { embedder, reranker: new FakeReranker() }, RETRIEVAL_CONFIG),
    ).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });
});
