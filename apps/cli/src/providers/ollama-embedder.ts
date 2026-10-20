// bge-m3 embeddings via Ollama's native `/api/embed` (no instruction prefix needed for bge-m3).
import type { Embedder } from "@satya/core";
import { postJson } from "./retry";

const BATCH = 32;

export class OllamaEmbedder implements Embedder {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 120_000,
  ) {}

  async embed(texts: string[], _kind: "query" | "doc"): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const { embeddings } = await postJson<{ embeddings: number[][] }>(
        `${this.baseUrl}/api/embed`,
        { model: this.model, input: texts.slice(i, i + BATCH) },
        this.timeoutMs,
      );
      for (const e of embeddings) out.push(Float32Array.from(e));
    }
    return out;
  }
}
