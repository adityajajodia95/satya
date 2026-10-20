// Qwen3 via Ollama's native /api/chat: JSON-schema `format`, per-task thinking (`think`), and per-request
// `num_ctx` — the OpenAI-compatible endpoint cannot set num_ctx, so the native API is used (PROGRESS D11).
import type { LLM, LlmRequest, LlmResponse } from "@satya/core";
import type { LaptopConfig } from "../config";
import { postJson } from "./retry";

interface ChatResponse {
  message: { content: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export class OllamaLLM implements LLM {
  constructor(
    private readonly cfg: LaptopConfig["llm"],
    private readonly timeoutMs = 300_000,
  ) {}

  /** Qwen3 thinks only for the tasks listed in laptop.json `think` (judge, decomposer); §9, PROGRESS D15. */
  thinks(task: string): boolean {
    return this.cfg.think[task] ?? this.cfg.think.default;
  }

  /** Request body for /api/chat (exposed for tests). */
  body(req: LlmRequest): object {
    const think = this.thinks(req.task);
    // Qwen3 thinking for the judge used up to 3,205 tokens in a 10-seed probe; a fixed cap truncated
    // samples to empty answers, so thinking tasks may fill the remaining context (num_predict −2).
    const numPredict = think ? -2 : req.maxTokens;
    return {
      model: this.cfg.model,
      messages: req.messages,
      stream: false,
      think,
      ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
      options: {
        num_ctx: this.cfg.numCtx,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.seed === undefined ? {} : { seed: req.seed }),
        ...(numPredict === undefined ? {} : { num_predict: numPredict }),
      },
    };
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const data = await postJson<ChatResponse>(`${this.cfg.baseUrl}/api/chat`, this.body(req), this.timeoutMs);
    return {
      text: data.message.content,
      usage: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 },
      model: this.cfg.model,
      provider: "ollama",
    };
  }
}
