import type { SatyaConfig } from "../config";
import { renderEvidence, renderTranscript } from "../prompts";
import type { Argument, Evidence, Side } from "../schemas";
import { type AgentContext, MAX_TOKENS, callJson } from "./llm-call";

/** Valid evidence ids cited either in the JSON `cited` list or inline as [E2] in the text. */
export function citedIds(text: string, cited: readonly string[], evidence: readonly Evidence[]): string[] {
  const valid = new Set(evidence.map((e) => e.id));
  const inline = [...text.matchAll(/\bE(\d+)\b/g)].map((m) => `E${m[1]}`);
  const normalised = cited.map((c) => c.replace(/[[\]\s]/g, "").toUpperCase());
  return [...new Set([...normalised, ...inline])]
    .filter((id) => valid.has(id))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** One debate turn for `side` in `round`; the transcript so far keeps the last 2 turns per side (§9). */
export async function argue(
  ctx: AgentContext,
  side: Side,
  round: number,
  claim: { id: string; text: string },
  evidence: readonly Evidence[],
  transcript: readonly Argument[],
  cfg: SatyaConfig,
): Promise<Argument> {
  const { output } = await callJson(
    ctx,
    side,
    {
      claim: claim.text,
      evidence: renderEvidence(evidence, cfg.retrieval.evidenceChars),
      transcript: renderTranscript(transcript),
    },
    { temperature: cfg.llm.temperature, reasoning: cfg.llm.reasoning.default, maxTokens: MAX_TOKENS[side] },
  );
  return {
    claimId: claim.id,
    side,
    round,
    text: output.argument.trim(),
    cited: citedIds(output.argument, output.cited, evidence),
  };
}
