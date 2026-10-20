// Opt-in M4 acceptance: 3 hand-written claims through the agents with the real laptop models and live
// Wikipedia; at least 2 of 3 verdicts must be correct (an abstention counts as wrong).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type AgentContext,
  type Argument,
  type Label,
  SatyaConfig,
  aggregateSamples,
  argue,
  collectPassages,
  judgeSample,
  plan,
  planFetches,
  planSearches,
  retrieveEvidence,
} from "@satya/core";
import { MemorySink, TickClock } from "@satya/core/testing";
import { HostRateLimiter, MemoryToolCache, createTools } from "@satya/tools";
import { htmlToTextNode } from "@satya/tools/text/node";
import { describe, expect, it } from "vitest";
import { loadLaptopConfig } from "../src/config";
import { OllamaEmbedder } from "../src/providers/ollama-embedder";
import { OllamaLLM } from "../src/providers/ollama-llm";
import { TransformersReranker } from "../src/providers/transformers-reranker";

const config = SatyaConfig.parse(
  JSON.parse(readFileSync(new URL("../../../configs/default.json", import.meta.url), "utf8")),
);
const laptop = loadLaptopConfig();
const llm = new OllamaLLM(laptop.llm);
const embedder = new OllamaEmbedder(laptop.llm.baseUrl, laptop.embed.model);
const reranker = new TransformersReranker(laptop.rerank.model, laptop.rerank.dtype);
const tools = createTools({
  config: config.tools,
  htmlToText: htmlToTextNode,
  cache: new MemoryToolCache(),
  limiter: new HostRateLimiter(),
});
const sink = new MemorySink();
const LOG = new URL("../../../results/acceptance/m4-agents.log", import.meta.url);
mkdirSync(new URL(".", LOG), { recursive: true });
writeFileSync(
  LOG,
  `M4 acceptance run ${new Date().toISOString()} — qwen3:4b + bge-m3 (Ollama) + bge-reranker-base (ONNX CPU), live Wikipedia\n\n`,
);
const log = (line: string) => {
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};
const ctx = (step: string): AgentContext => ({ llm, sink, clock: new TickClock(), step });

const CLAIMS: { text: string; expected: Label }[] = [
  { text: "The Eiffel Tower is located in Berlin.", expected: "REFUTED" },
  { text: "Penicillin was discovered by Alexander Fleming in 1928.", expected: "SUPPORTED" },
  { text: "Mount Everest is the highest mountain on Earth above sea level.", expected: "SUPPORTED" },
];

async function check(id: string, text: string) {
  const p = await plan(ctx(`plan:${id}`), text, config);
  const searches = await Promise.all(
    planSearches(id, p, ["wikipedia"], config.tools.enabled).map((s) => tools.call(s.tool, s.args)),
  );
  const fetches = await Promise.all(
    planFetches(id, searches, config.tools.enabled).map((f) => tools.call(f.tool, f.args)),
  );
  const passages = collectPassages(text, [...searches, ...fetches], config);
  const evidence = await retrieveEvidence(text, passages, { embedder, reranker }, config.retrieval);
  const debate: Argument[] = [];
  for (let round = 1; round <= config.pipeline.debateRounds; round++) {
    for (const side of ["advocate", "skeptic"] as const) {
      debate.push(
        await argue(
          ctx(`argue:${id}:r${round}:${side}`),
          side,
          round,
          { id, text },
          evidence,
          debate,
          config,
        ),
      );
    }
  }
  const samples = [];
  for (let s = 1; s <= config.pipeline.judgeSamples; s++) {
    samples.push(await judgeSample(ctx(`judge:${id}:s${s}`), text, evidence, debate, s, config));
  }
  return {
    plan: p,
    passages: passages.length,
    evidence,
    debate,
    verdict: aggregateSamples(id, samples, evidence, config.pipeline.abstainThreshold),
  };
}

describe("M4 acceptance: agents with laptop models", () => {
  it("gets at least 2 of 3 hand-written claims right", async () => {
    let correct = 0;
    for (const [i, claim] of CLAIMS.entries()) {
      const started = Date.now();
      const r = await check(`c${i + 1}`, claim.text);
      const ok = !r.verdict.abstained && r.verdict.label === claim.expected;
      correct += ok ? 1 : 0;
      log(
        [
          `${ok ? "CORRECT" : "WRONG  "} ${claim.text}`,
          `  expected ${claim.expected}; got ${r.verdict.label} (raw ${r.verdict.rawLabel}, samples ${r.verdict.samples.join("/")}, confidence ${r.verdict.confidence.toFixed(3)}, cited ${r.verdict.cited.join(",") || "-"})`,
          `  queries: ${r.plan.queries.join(" | ")}; passages ${r.passages}; ${((Date.now() - started) / 1000).toFixed(1)} s`,
          ...r.evidence.map(
            (e) =>
              `  ${e.id} rerank=${e.rerank.toFixed(2)} ${e.passage.title}: ${e.passage.text.slice(0, 90)}…`,
          ),
          `  judge rationale: ${r.verdict.rationale.slice(0, 220)}`,
        ].join("\n"),
      );
    }
    const repairs = sink.spans.filter((s) => s.step.endsWith(":repair")).length;
    log(`${correct}/3 correct; LLM calls ${sink.spans.length} (repairs ${repairs})`);
    expect(correct).toBeGreaterThanOrEqual(2);
  }, 1_800_000);
});
