// SatyaWorkflow (§7 M9): durable orchestration. Each pipeline step is its own `step.do` (retries 3,
// exponential from 2 s; timeout 90 s for LLM steps, 20 s otherwise) executed by the run's RunHubDO; the
// frontier comes from the same `planSteps` as the laptop runner, so both walk the same step sequence.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CLOUD } from "./config";
import { type SatyaEnv, hubOf } from "./env";
import { startNextParity } from "./parity";

export interface WorkflowParams {
  runId: string;
}

export interface StepDriver {
  do<T>(name: string, config: object, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const stepConfig = (kind: string) => ({
  retries: { limit: CLOUD.stepRetries, delay: "2 seconds" as const, backoff: "exponential" as const },
  timeout:
    kind === "llm"
      ? (`${CLOUD.perStepTimeoutS.llm} seconds` as const)
      : (`${CLOUD.perStepTimeoutS.tool} seconds` as const),
});

/** The orchestration loop, separated from the class so tests can drive it with a fake step runner. */
export async function orchestrate(env: SatyaEnv, runId: string, step: StepDriver): Promise<string[]> {
  const hub = hubOf(env, runId);
  const executed: string[] = [];
  await step.do("start", () => hub.start());
  for (let i = 0; ; i++) {
    const frontier = await step.do(`frontier:${i}`, () => hub.frontier());
    if (frontier.length === 0) break;
    await Promise.all(
      frontier.map(async ({ name, kind }) => {
        try {
          await step.do(name, stepConfig(kind), () => hub.execute(name));
        } catch (e) {
          await step.do(`fail:${name}`, () => hub.fail(name, String((e as Error)?.message ?? e)));
        }
      }),
    );
    executed.push(...frontier.map((s) => s.name));
  }
  await step.do("finalize", () => hub.finalize());
  return executed;
}

export class SatyaWorkflow extends WorkflowEntrypoint<SatyaEnv, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    await orchestrate(this.env, event.payload.runId, step as unknown as StepDriver);
    // Parity runs chain: each finished item starts the next one while the nightly window is open.
    if (event.payload.runId.startsWith("parity-")) await step.do("chain", () => startNextParity(this.env));
  }
}
