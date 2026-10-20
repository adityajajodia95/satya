import type { Verdict } from "../schemas";

/** factuality = supported / (supported + refuted); null when no claim was decided either way (§6). */
export function factuality(verdicts: readonly Verdict[]): number | null {
  const supported = verdicts.filter((v) => v.label === "SUPPORTED").length;
  const refuted = verdicts.filter((v) => v.label === "REFUTED").length;
  return supported + refuted === 0 ? null : supported / (supported + refuted);
}

export function summarize(verdicts: readonly Verdict[]) {
  return {
    claims: verdicts.length,
    supported: verdicts.filter((v) => v.label === "SUPPORTED").length,
    refuted: verdicts.filter((v) => v.label === "REFUTED").length,
    notEnoughInfo: verdicts.filter((v) => v.label === "NOT_ENOUGH_INFO").length,
    abstained: verdicts.filter((v) => v.abstained).length,
    factuality: factuality(verdicts),
  };
}
