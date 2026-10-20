// Run state and patches. The state is plain JSON (stored in RunHubDO in the cloud); every step returns a
// serialisable patch (what a Workflow `step.do` must return) and `applyPatch` folds it in — purely.
import type { SourceChoice } from "../config";
import type { JudgeSample } from "../agents/judge";
import type { Plan } from "../agents/planner";
import type { Candidate } from "../retrieval/pipeline";
import type { Argument, Claim, Evidence, ToolResult, Verdict } from "../schemas";

/** Which pipeline to run: the full system or one of the evaluation baselines/ablations (§7 M7). */
export interface Variant {
  name: string;
  /** Decompose input text into claims (false when evaluating a single given claim). */
  decompose: boolean;
  /** "tools" = research with MCP tools; "corpus" = closed corpus (SciFact); "none" = no evidence (LLM-only). */
  evidence: "tools" | "corpus" | "none";
  retrieval: "hybrid" | "dense";
  rerank: boolean;
  debateRounds: number;
  /** "judge" = Satya judge × samples; "single_agent" = one call with verbal confidence; "llm_only". */
  verdict: "judge" | "single_agent" | "llm_only";
  judgeSamples: number;
}

export interface ClaimState {
  plan?: Plan;
  /** Tool results keyed by step name (`search:c1:q2:wiki`, `fetch:c1:3`). */
  tools: Record<string, ToolResult>;
  candidates?: Candidate[];
  passageCount?: number;
  evidence?: Evidence[];
  debate: Argument[];
  samples: Record<number, JudgeSample>;
  verdict?: Verdict;
}

export interface RunState {
  runId: string;
  inputText: string;
  sources: SourceChoice[];
  maxClaims: number;
  variant: Variant;
  claims: Claim[] | null;
  perClaim: Record<string, ClaimState>;
  /** Claims not checked because capacity ran out mid-run (cloud) — the report is then `partial`. */
  partial: boolean;
  done: boolean;
}

export type StatePatch =
  | { type: "claims"; claims: Claim[] }
  | { type: "plan"; claimId: string; plan: Plan }
  | { type: "tool"; claimId: string; step: string; result: ToolResult }
  | { type: "candidates"; claimId: string; candidates: Candidate[]; passageCount: number }
  | { type: "evidence"; claimId: string; evidence: Evidence[] }
  | { type: "argument"; claimId: string; argument: Argument }
  | { type: "sample"; claimId: string; index: number; sample: JudgeSample }
  | { type: "verdict"; claimId: string; verdict: Verdict }
  | { type: "capacity"; claimIds: string[] }
  | { type: "done" };

export const emptyClaimState = (): ClaimState => ({ tools: {}, debate: [], samples: {} });

export function initialState(input: {
  runId: string;
  text: string;
  sources: SourceChoice[];
  maxClaims: number;
  variant: Variant;
}): RunState {
  const claims: Claim[] | null = input.variant.decompose
    ? null
    : [{ id: "c1", text: input.text, quote: input.text, span: [0, input.text.length], checkworthy: true }];
  return {
    runId: input.runId,
    inputText: input.text,
    sources: input.sources,
    maxClaims: input.maxClaims,
    variant: input.variant,
    claims,
    perClaim: Object.fromEntries((claims ?? []).map((c) => [c.id, emptyClaimState()])),
    partial: false,
    done: false,
  };
}

/** NEI verdict for a claim that could not be checked (`pipeline error`, `capacity`). */
export const unverified = (claimId: string, rationale: string): Verdict => ({
  claimId,
  label: "NOT_ENOUGH_INFO",
  rawLabel: "NOT_ENOUGH_INFO",
  confidence: 0,
  abstained: true,
  rationale,
  cited: [],
  samples: [],
});

export function applyPatch(state: RunState, patch: StatePatch): RunState {
  const claim = (id: string, update: (c: ClaimState) => ClaimState): RunState => ({
    ...state,
    perClaim: { ...state.perClaim, [id]: update(state.perClaim[id] ?? emptyClaimState()) },
  });
  switch (patch.type) {
    case "claims":
      return {
        ...state,
        claims: patch.claims,
        perClaim: Object.fromEntries(patch.claims.map((c) => [c.id, emptyClaimState()])),
      };
    case "plan":
      return claim(patch.claimId, (c) => ({ ...c, plan: patch.plan }));
    case "tool":
      return claim(patch.claimId, (c) => ({ ...c, tools: { ...c.tools, [patch.step]: patch.result } }));
    case "candidates":
      return claim(patch.claimId, (c) => ({
        ...c,
        candidates: patch.candidates,
        passageCount: patch.passageCount,
      }));
    case "evidence":
      return claim(patch.claimId, (c) => ({ ...c, evidence: patch.evidence }));
    case "argument":
      return claim(patch.claimId, (c) => ({ ...c, debate: [...c.debate, patch.argument] }));
    case "sample":
      return claim(patch.claimId, (c) => ({ ...c, samples: { ...c.samples, [patch.index]: patch.sample } }));
    case "verdict":
      return claim(patch.claimId, (c) => ({ ...c, verdict: patch.verdict }));
    case "capacity": {
      let next: RunState = { ...state, partial: true };
      for (const id of patch.claimIds)
        next = applyPatch(next, { type: "verdict", claimId: id, verdict: unverified(id, "capacity") });
      return next;
    }
    case "done":
      return { ...state, done: true };
  }
}

/** Claims that will be checked (check-worthy), in input order. */
export const checkable = (state: RunState): Claim[] => (state.claims ?? []).filter((c) => c.checkworthy);
