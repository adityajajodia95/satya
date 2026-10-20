import { readFileSync } from "node:fs";
import { repoPath } from "./paths";

export interface LaptopConfig {
  llm: {
    provider: "ollama";
    model: string;
    baseUrl: string;
    numCtx: number;
    /** Qwen3 thinking per task (prompt name); `default` applies to every other task. */
    think: { default: boolean } & Partial<Record<string, boolean>>;
  };
  embed: { provider: "ollama"; model: string };
  rerank: { provider: "transformers"; model: string; dtype: "fp32" };
}

export function readJsonConfig<T>(name: string): T {
  return JSON.parse(readFileSync(repoPath("configs", name), "utf8")) as T;
}

/** laptop.json; SATYA_OLLAMA_URL overrides the Ollama base URL (one server per GPU on Kaggle). */
export const loadLaptopConfig = (): LaptopConfig => {
  const cfg = readJsonConfig<LaptopConfig>("laptop.json");
  const url = process.env.SATYA_OLLAMA_URL;
  return url ? { ...cfg, llm: { ...cfg.llm, baseUrl: url } } : cfg;
};
