import type { SatyaConfig } from "../config";
import type { Claim } from "../schemas";
import { type AgentContext, MAX_TOKENS, callJson } from "./llm-call";
import { locateQuote } from "./locate";

/**
 * text → Claim[]. Claims get ids c1..cn in order; each `quote` is located in the input for highlighting.
 * At most `maxClaims` check-worthy claims are kept (non-check-worthy ones are kept for display).
 */
export async function decompose(
  ctx: AgentContext,
  text: string,
  cfg: SatyaConfig,
  maxClaims: number,
): Promise<Claim[]> {
  const { output } = await callJson(
    ctx,
    "decomposer",
    { text },
    {
      temperature: cfg.llm.temperature,
      reasoning: cfg.llm.reasoning.default,
      maxTokens: MAX_TOKENS.decomposer,
    },
  );
  const claims: Claim[] = [];
  let checkworthy = 0;
  for (const raw of output.claims) {
    const claimText = raw.text.trim();
    if (!claimText) continue;
    if (raw.checkworthy && checkworthy >= maxClaims) continue;
    if (raw.checkworthy) checkworthy++;
    claims.push({
      id: `c${claims.length + 1}`,
      text: claimText,
      quote: raw.quote.trim(),
      span: locateQuote(text, raw.quote) ?? locateQuote(text, claimText),
      checkworthy: raw.checkworthy,
    });
  }
  return claims;
}
