import type { SatyaConfig } from "../config";
import { type AgentContext, MAX_TOKENS, callJson } from "./llm-call";

export interface Plan {
  queries: string[];
  scientific: boolean;
}

/** claim → 2–3 search queries + `scientific` flag (queries trimmed, de-duplicated, capped). */
export async function plan(ctx: AgentContext, claim: string, cfg: SatyaConfig): Promise<Plan> {
  const { output } = await callJson(
    ctx,
    "planner",
    { claim },
    {
      temperature: cfg.llm.temperature,
      reasoning: cfg.llm.reasoning.default,
      maxTokens: MAX_TOKENS.planner,
    },
  );
  const seen = new Set<string>();
  const queries = output.queries
    // Small models sometimes echo the instructions into a query ("key entities: …", "… scientific=true").
    .map((q) =>
      q
        .replace(/\bscientific\s*[=:]\s*(true|false)\b/gi, "")
        .replace(/^\s*(key entities|entities|question|query)\s*:\s*/i, "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 300),
    )
    .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
    .slice(0, cfg.pipeline.queriesPerClaim);
  // The claim itself is always a usable query if the model returned none.
  return { queries: queries.length ? queries : [claim.slice(0, 300)], scientific: output.scientific };
}
