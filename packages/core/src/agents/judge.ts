// Judge (§6, §7 M4): `judgeSamples` independent samples → majority vote → calibrated confidence → abstain.
import type { SatyaConfig } from "../config";
import { renderEvidence, renderTranscript } from "../prompts";
import type { Argument, Evidence, Label, Verdict } from "../schemas";
import { citedIds } from "./debaters";
import { type AgentContext, MAX_TOKENS, callJson } from "./llm-call";

export interface JudgeSample {
  label: Label;
  rationale: string;
  cited: string[];
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** One judge sample (step `judge:<claim>:s<i>`); seeds differ per sample so samples are independent. */
export async function judgeSample(
  ctx: AgentContext,
  claim: string,
  evidence: readonly Evidence[],
  transcript: readonly Argument[],
  sampleIndex: number,
  cfg: SatyaConfig,
): Promise<JudgeSample> {
  const { output } = await callJson(
    ctx,
    "judge",
    {
      claim,
      evidence: renderEvidence(evidence, cfg.retrieval.evidenceChars),
      transcript: renderTranscript(transcript),
    },
    {
      temperature: cfg.llm.judgeTemperature,
      reasoning: cfg.llm.reasoning.judge,
      maxTokens: MAX_TOKENS.judge,
      seed: sampleIndex,
    },
  );
  return {
    label: output.label,
    rationale: output.rationale.trim(),
    cited: citedIds(output.rationale, output.cited, evidence),
  };
}

/** Majority label; ties prefer NOT_ENOUGH_INFO (the conservative choice), then the earliest sample. */
export function majority(labels: readonly Label[]): Label {
  const counts = new Map<Label, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = labels.filter((l) => counts.get(l) === top);
  return tied.includes("NOT_ENOUGH_INFO") ? "NOT_ENOUGH_INFO" : (tied[0] as Label);
}

/**
 * agreement = count(majority) / samples; strength = sigmoid(max re-rank logit of evidence cited by the
 * majority samples; 0 if none); confidence = 0.7·agreement + 0.3·strength. A SUPPORTED/REFUTED majority
 * without any citation becomes NOT_ENOUGH_INFO; confidence < τ → abstained, label NEI, rawLabel kept.
 */
export function aggregateSamples(
  claimId: string,
  samples: readonly JudgeSample[],
  evidence: readonly Evidence[],
  threshold: number,
): Verdict {
  if (samples.length === 0) throw new Error("no judge samples");
  const labels = samples.map((s) => s.label);
  const majorityLabel = majority(labels);
  const agreeing = samples.filter((s) => s.label === majorityLabel);
  const cited = [...new Set(agreeing.flatMap((s) => s.cited))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  const rawLabel: Label =
    majorityLabel !== "NOT_ENOUGH_INFO" && cited.length === 0 ? "NOT_ENOUGH_INFO" : majorityLabel;
  const agreement = agreeing.length / samples.length;
  const citedScores = evidence.filter((e) => cited.includes(e.id)).map((e) => e.rerank);
  const strength = citedScores.length ? sigmoid(Math.max(...citedScores)) : 0;
  const confidence = Math.min(1, Math.max(0, 0.7 * agreement + 0.3 * strength));
  const abstained = confidence < threshold;
  return {
    claimId,
    label: abstained ? "NOT_ENOUGH_INFO" : rawLabel,
    rawLabel,
    confidence,
    abstained,
    rationale: agreeing[0]?.rationale ?? "",
    cited,
    samples: labels,
  };
}
