// Generic sequential runner (laptop executor): runs each frontier concurrently, applies the patches in
// frontier order, isolates per-claim failures (NEI "pipeline error"), and builds the report.
import { factuality } from "../agents/aggregator";
import type { Report, Span } from "../schemas";
import { type RunState, type StatePatch, applyPatch, checkable, unverified } from "./state";
import { type Step, type StepContext, estimateTotalSteps, planSteps } from "./steps";

export const PIPELINE_ERROR = "pipeline error";

export interface LocalRunResult {
  state: RunState;
  steps: string[];
}

export async function runLocal(initial: RunState, ctx: StepContext): Promise<LocalRunResult> {
  const { sink } = ctx.ports;
  let state = initial;
  const steps: string[] = [];
  await sink.emit({ type: "run_started", data: { runId: state.runId, variant: state.variant.name } });
  try {
    for (
      let frontier = planSteps(state, ctx.config);
      frontier.length;
      frontier = planSteps(state, ctx.config)
    ) {
      const patches = await Promise.all(frontier.map((step) => runStep(step, ctx, state)));
      frontier.forEach((step, i) => {
        steps.push(step.name);
        state = applyPatch(state, patches[i] as StatePatch);
      });
      await sink.emit({
        type: "stage",
        data: {
          step: steps.length,
          of: state.done ? steps.length : Math.max(steps.length, estimateTotalSteps(state, ctx.config)),
          last: steps.at(-1),
        },
      });
    }
  } catch (e) {
    await sink.emit({ type: "run_failed", data: { message: (e as Error).message } });
    throw e;
  }
  await sink.emit({
    type: "run_completed",
    data: { factuality: factuality(verdictsOf(state)), partial: state.partial },
  });
  return { state, steps };
}

/** A failing claim step yields an NEI verdict for that claim; a failing `decompose` fails the run. */
async function runStep(step: Step, ctx: StepContext, state: RunState): Promise<StatePatch> {
  try {
    return await step.run(ctx, state);
  } catch (e) {
    if (!step.claimId) throw e;
    const verdict = unverified(step.claimId, PIPELINE_ERROR);
    await ctx.ports.sink.emit({
      type: "verdict",
      data: { ...verdict, error: `${step.name}: ${(e as Error).message}` },
    });
    return { type: "verdict", claimId: step.claimId, verdict };
  }
}

export const verdictsOf = (state: RunState) =>
  checkable(state).flatMap((c) => (state.perClaim[c.id]?.verdict ? [state.perClaim[c.id]!.verdict!] : []));

export function buildReport(
  state: RunState,
  trace: Span[],
  meta: { model: string; provider: string; createdAt: string; executor: "laptop" | "cloud" },
): Report {
  const claims = state.claims ?? [];
  const pick = <T>(f: (id: string) => T | undefined) =>
    Object.fromEntries(claims.flatMap((c) => (f(c.id) === undefined ? [] : [[c.id, f(c.id) as T]])));
  return {
    runId: state.runId,
    inputText: state.inputText,
    claims,
    evidence: pick((id) => state.perClaim[id]?.evidence),
    debate: pick((id) => state.perClaim[id]?.debate),
    verdicts: pick((id) => state.perClaim[id]?.verdict),
    factuality: factuality(verdictsOf(state)),
    trace,
    ...meta,
    partial: state.partial,
  };
}
