// Opt-in (`npm run test:integration`): the M3 tiny-corpus test with the real laptop models.
import { retrieveEvidence } from "@satya/core";
import { RETRIEVAL_CONFIG, TINY_CORPUS, TINY_QUERIES } from "@satya/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLaptopConfig } from "../src/config";
import { OllamaEmbedder } from "../src/providers/ollama-embedder";
import { TransformersReranker } from "../src/providers/transformers-reranker";

const cfg = loadLaptopConfig();
const ports = {
  embedder: new OllamaEmbedder(cfg.llm.baseUrl, cfg.embed.model),
  reranker: new TransformersReranker(cfg.rerank.model, cfg.rerank.dtype),
};

describe("tiny corpus with laptop ports (bge-m3 via Ollama + bge-reranker-base ONNX on CPU)", () => {
  beforeAll(async () => {
    await ports.reranker.score("warm-up", ["load the model once"]);
  }, 600_000);

  it.each(TINY_QUERIES)(
    "'$query' → $expected first",
    async ({ query, expected }) => {
      const evidence = await retrieveEvidence(query, TINY_CORPUS, ports, RETRIEVAL_CONFIG);
      console.log(
        `${query}\n` +
          evidence
            .map(
              (e) =>
                `  ${e.id} ${e.passage.id.padEnd(12)} rerank=${e.rerank.toFixed(3)} bm25=${e.bm25Rank} dense=${e.denseRank}`,
            )
            .join("\n"),
      );
      expect(evidence[0]!.passage.id).toBe(expected);
    },
    120_000,
  );

  it("bge-m3 vectors are 1024-d and the re-ranker returns raw logits (can be negative)", async () => {
    const [v] = await ports.embedder.embed(["Eiffel Tower"], "query");
    expect(v).toHaveLength(1024);
    const [hi, lo] = await ports.reranker.score("Eiffel Tower completion year", [
      TINY_CORPUS[0]!.text,
      TINY_CORPUS[3]!.text,
    ]);
    expect(hi).toBeGreaterThan(lo!);
    expect(lo).toBeLessThan(0);
  }, 120_000);
});
