import { describe, expect, it } from "vitest";
import { loadLaptopConfig } from "../src/config";
import { OllamaLLM } from "../src/providers/ollama-llm";

const llm = new OllamaLLM(loadLaptopConfig().llm);
const req = (task: string) => ({
  task,
  messages: [{ role: "user" as const, content: "x" }],
  jsonSchema: { type: "object" },
  temperature: 0.7,
  seed: 2,
  maxTokens: 512,
});

describe("Ollama chat adapter", () => {
  it("thinks only for the judge and the decomposer (laptop.json think map)", () => {
    expect(llm.thinks("judge")).toBe(true);
    expect(llm.thinks("decomposer")).toBe(true);
    for (const task of ["planner", "advocate", "skeptic", "llm_only", "single_agent"]) {
      expect(llm.thinks(task)).toBe(false);
    }
  });

  it("sends schema, num_ctx 8192, temperature, seed and the token cap for non-thinking tasks", () => {
    expect(llm.body(req("planner"))).toEqual({
      model: "qwen3:4b",
      messages: [{ role: "user", content: "x" }],
      stream: false,
      think: false,
      format: { type: "object" },
      options: { num_ctx: 8192, temperature: 0.7, seed: 2, num_predict: 512 },
    });
  });

  it("lets judge thinking fill the remaining context", () => {
    expect(llm.body(req("judge"))).toMatchObject({
      think: true,
      options: { num_predict: -2, num_ctx: 8192 },
    });
  });
});

describe("retries for local model servers", () => {
  it("retries transient failures (network, 5xx, 429) up to 2 times, then gives up", async () => {
    const { withRetries, HttpError } = await import("../src/providers/retry");
    const sleeps: number[] = [];
    const sleep = (ms: number) => (sleeps.push(ms), Promise.resolve());
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve("ok"));
    expect(await withRetries(flaky, { sleep })).toBe("ok");
    expect(sleeps).toEqual([1000, 2000]);
    calls = 0;
    await expect(
      withRetries(() => (calls++, Promise.reject(new HttpError(503, "busy"))), { sleep }),
    ).rejects.toThrow("busy");
    expect(calls).toBe(3);
  });

  it("does not retry client errors", async () => {
    const { withRetries, HttpError } = await import("../src/providers/retry");
    let calls = 0;
    await expect(
      withRetries(() => (calls++, Promise.reject(new HttpError(400, "bad request"))), {
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("re-ranker model loading", () => {
  it("treats the model as cached only when all its files exist (fresh machines download it)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TransformersReranker } = await import("../src/providers/transformers-reranker");
    const dir = mkdtempSync(join(tmpdir(), "tjs-"));
    const r = new TransformersReranker("Xenova/bge-reranker-base");
    expect(r.isCached(dir)).toBe(false);
    const model = join(dir, "Xenova", "bge-reranker-base");
    mkdirSync(join(model, "onnx"), { recursive: true });
    for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json"])
      writeFileSync(join(model, f), "{}");
    expect(r.isCached(dir)).toBe(false);
    writeFileSync(join(model, "onnx", "model.onnx"), "x");
    expect(r.isCached(dir)).toBe(true);
  }, 30_000); // imports transformers.js (slow when the CPU is busy with an evaluation)
});
