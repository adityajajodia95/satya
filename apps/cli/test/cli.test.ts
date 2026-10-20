import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Report, retrievalText, topKByCosine } from "@satya/core";
import { FakeEmbedder } from "@satya/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { buildScifactIndex, corpusPassages, loadScifactIndex } from "../src/scifact-index";
import { SatyaStore } from "../src/store/sqlite";
import { formatReport } from "../src/verify";

const RETRIEVAL = {
  chunkWords: 220,
  chunkOverlap: 40,
  bm25K: 20,
  denseK: 20,
  rrfK: 60,
  rerankTop: 20,
  finalK: 5,
  evidenceChars: 900,
  maxPassages: 60,
};
const tmp = mkdtempSync(join(tmpdir(), "satya-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("SatyaStore", () => {
  it("caches tool results until they expire", async () => {
    let now = 1000;
    const store = new SatyaStore(":memory:");
    const cache = store.toolCache(() => now);
    const docs = [{ source: "web" as const, url: "u", title: "t", text: "x", published: null }];
    await cache.put("k", docs, 10);
    expect(await cache.get("k")).toEqual(docs);
    now += 10_001;
    expect(await cache.get("k")).toBeNull();
    store.close();
  });

  it("guards a monthly credit budget and resets next month", async () => {
    let date = new Date("2026-10-31T23:00:00Z");
    const store = new SatyaStore(":memory:");
    const guard = store.creditGuard("tavily", 2, () => date);
    expect([await guard.tryConsume(), await guard.tryConsume(), await guard.tryConsume()]).toEqual([
      true,
      true,
      false,
    ]);
    expect(guard.used()).toBe(2);
    date = new Date("2026-11-01T00:00:00Z");
    expect(await guard.tryConsume()).toBe(true);
    store.close();
  });
});

describe("SciFact index", () => {
  const corpus = [
    {
      doc_id: 11,
      title: "Statins and cardiovascular risk",
      abstract: ["Statins reduce LDL cholesterol.", "They lower cardiovascular events."],
    },
    {
      doc_id: 22,
      title: "Vitamin D and fractures",
      abstract: ["Vitamin D supplementation did not reduce fractures in older adults."],
    },
    {
      doc_id: 33,
      title: "Aspirin and colorectal cancer",
      abstract: Array.from(
        { length: 60 },
        (_, i) => `Sentence ${i} about aspirin and colorectal cancer incidence.`,
      ),
    },
  ];
  const file = join(tmp, "corpus.jsonl");
  writeFileSync(file, corpus.map((d) => JSON.stringify(d)).join("\n") + "\n");

  it("chunks abstracts with stable ids and no URL (closed corpus)", () => {
    const passages = corpusPassages(corpus.map((d) => JSON.stringify(d)).join("\n"), RETRIEVAL);
    expect(passages.map((p) => p.docId)).toEqual([11, 22, 33, 33, 33]);
    expect(passages.every((p) => p.url === null && p.source === "corpus")).toBe(true);
  });

  it("round-trips vectors and metadata; exact cosine finds the right abstract", async () => {
    const dir = join(tmp, "index");
    const embedder = new FakeEmbedder();
    const built = await buildScifactIndex(embedder, RETRIEVAL, { corpus: file, dir, log: () => undefined });
    expect(built).toMatchObject({ passages: 5, dim: 256 });
    const index = loadScifactIndex(dir);
    expect(index.passages).toHaveLength(5);
    expect(index.vectors[0]).toHaveLength(256);
    const norms = index.vectors.map((v) => Math.hypot(...v));
    norms.forEach((n) => expect(n).toBeCloseTo(1, 5));
    const [q] = await embedder.embed(["Vitamin D supplementation and fractures"], "query");
    expect(index.passages[topKByCosine(q!, index.vectors, 1)[0]!]!.docId).toBe(22);
    expect(index.bm25.topK("aspirin colorectal", 1).map((i) => index.passages[i]!.docId)).toEqual([33]);
    expect(retrievalText(index.passages[1]!)).toMatch(/^Vitamin D and fractures\n/);
  });
});

describe("verify output", () => {
  it("prints one row per check-worthy claim with verdict, confidence and cited sources", () => {
    const passage = {
      id: "p",
      source: "wikipedia" as const,
      url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
      title: "Eiffel Tower",
      text: "…",
      published: null,
    };
    const report: Report = {
      runId: "r",
      inputText: "x",
      claims: [
        {
          id: "c1",
          text: "The Eiffel Tower was completed in 1889.",
          quote: "q",
          span: null,
          checkworthy: true,
        },
        { id: "c2", text: "I love it.", quote: "q", span: null, checkworthy: false },
      ],
      evidence: { c1: [{ id: "E1", passage, bm25Rank: 1, denseRank: 1, rrf: 0.03, rerank: 7 }] },
      debate: {},
      verdicts: {
        c1: {
          claimId: "c1",
          label: "SUPPORTED",
          rawLabel: "SUPPORTED",
          confidence: 0.92,
          abstained: false,
          rationale: "E1",
          cited: ["E1"],
          samples: [],
        },
      },
      factuality: 1,
      trace: [],
      model: "qwen3:4b",
      provider: "ollama",
      createdAt: "2026-10-13",
      executor: "laptop",
      partial: false,
    };
    const out = formatReport(report, false);
    expect(out).toContain("SUPPORTED");
    expect(out).toContain("0.92");
    expect(out).toContain("E1 wikipedia: Eiffel Tower");
    expect(out).not.toContain("I love it");
    expect(out).toContain("1 claims · 1 supported · 0 refuted · 0 not enough info · factuality 100%");
  });
});
