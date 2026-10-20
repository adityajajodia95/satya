// Cloud adapters: the core ports bound to aj-gateway RPC with the run's pinned provider (§6.3).
import type { Embedder, LLM, Reranker } from "@satya/core";
import type { GatewayRpc, Provider } from "../env";

export function gatewayLlm(gateway: GatewayRpc, pin: Provider, budgetClass: "demo" | "eval"): LLM {
  return {
    async chat(req) {
      const r = await gateway.llm({
        project: "satya",
        task: req.task,
        messages: req.messages,
        ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
        ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.seed === undefined ? {} : { seed: req.seed }),
        pin: { provider: pin },
        budgetClass,
      });
      return {
        text: r.text,
        ...(r.json === undefined ? {} : { json: r.json }),
        usage: r.usage,
        model: r.model,
        provider: r.provider,
        ...(r.neurons === undefined ? {} : { neurons: r.neurons }),
      };
    },
  };
}

export function gatewayEmbedder(gateway: GatewayRpc): Embedder {
  return {
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      return (await gateway.embed({ project: "satya", texts, kind })).map((v) => Float32Array.from(v));
    },
  };
}

/** The gateway already converts Workers AI's probabilities to logits (same scale as the laptop model). */
export function gatewayReranker(gateway: GatewayRpc): Reranker {
  return {
    score: (query, passages) =>
      passages.length ? gateway.rerank({ project: "satya", query, passages }) : Promise.resolve([]),
  };
}
