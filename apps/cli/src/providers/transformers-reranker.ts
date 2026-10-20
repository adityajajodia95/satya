// bge-reranker-base cross-encoder on CPU via transformers.js (ONNX, fp32). Returns raw logits.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  env,
} from "@huggingface/transformers";
import type { Reranker } from "@satya/core";

const BATCH = 8;
const MAX_TOKENS = 512;

/** Model files go to HF_HOME on D: (transformers.js otherwise caches inside node_modules). */
export function configureTransformersCache(hfHome = process.env.HF_HOME ?? "D:\\hf-cache"): string {
  env.cacheDir = join(hfHome, "transformers-js");
  return env.cacheDir;
}

export class TransformersReranker implements Reranker {
  private loaded?: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }>;

  constructor(
    private readonly modelId: string,
    private readonly dtype: "fp32" = "fp32",
  ) {}

  /** True when every file the model needs is already in the local cache. */
  isCached(cacheDir: string): boolean {
    const dir = join(cacheDir, ...this.modelId.split("/"));
    return ["config.json", "tokenizer.json", "tokenizer_config.json", join("onnx", "model.onnx")].every((f) =>
      existsSync(join(dir, f)),
    );
  }

  private load() {
    const cacheDir = configureTransformersCache();
    // Cached → never touch the network (closed-corpus runs work offline); otherwise download into the cache.
    // Decided from the files themselves: transformers.js does not reliably throw when a local file is missing.
    env.allowRemoteModels = !this.isCached(cacheDir);
    this.loaded ??= Promise.all([
      AutoTokenizer.from_pretrained(this.modelId),
      AutoModelForSequenceClassification.from_pretrained(this.modelId, { dtype: this.dtype, device: "cpu" }),
    ])
      .then(([tokenizer, model]) => ({ tokenizer, model }))
      .catch((e: unknown) => {
        this.loaded = undefined; // allow a retry after a transient download failure
        throw e;
      });
    return this.loaded;
  }

  async score(query: string, passages: string[]): Promise<number[]> {
    const { tokenizer, model } = await this.load();
    const scores: number[] = [];
    for (let i = 0; i < passages.length; i += BATCH) {
      const batch = passages.slice(i, i + BATCH);
      const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: MAX_TOKENS,
      });
      const { logits } = (await model(inputs)) as { logits: { data: Float32Array } };
      scores.push(...Array.from(logits.data));
    }
    return scores;
  }
}
