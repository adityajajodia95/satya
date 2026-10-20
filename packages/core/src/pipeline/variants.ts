// Systems compared in the evaluation (Satya_Project.md §9, §7 M7) — all run through the same steps.
import type { SatyaConfig } from "../config";
import type { Variant } from "./state";

export const SYSTEMS = [
  "llm_only",
  "single_agent_rag",
  "satya_no_debate",
  "satya_full",
  "dense_only",
  "no_rerank",
  "rounds_1",
  "rounds_3",
] as const;
export type SystemName = (typeof SYSTEMS)[number];

export interface VariantOptions {
  /** Decompose free text (demo / `verify`) or start from a given claim (evaluation). */
  decompose: boolean;
  /** Evidence from live tools or a closed corpus (SciFact). Ignored by `llm_only`. */
  evidence: "tools" | "corpus";
}

export function variantFor(system: SystemName, cfg: SatyaConfig, opts: VariantOptions): Variant {
  const full: Variant = {
    name: system,
    decompose: opts.decompose,
    evidence: opts.evidence,
    retrieval: "hybrid",
    rerank: true,
    debateRounds: cfg.pipeline.debateRounds,
    verdict: "judge",
    judgeSamples: cfg.pipeline.judgeSamples,
  };
  switch (system) {
    case "satya_full":
      return full;
    case "llm_only":
      return { ...full, evidence: "none", debateRounds: 0, verdict: "llm_only", judgeSamples: 1 };
    case "single_agent_rag":
      return { ...full, debateRounds: 0, verdict: "single_agent", judgeSamples: 1 };
    case "satya_no_debate":
      return { ...full, debateRounds: 0 };
    case "dense_only":
      return { ...full, retrieval: "dense" };
    case "no_rerank":
      return { ...full, rerank: false };
    case "rounds_1":
      return { ...full, debateRounds: 1 };
    case "rounds_3":
      return { ...full, debateRounds: 3 };
  }
}
