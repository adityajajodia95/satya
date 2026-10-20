// One structured LLM call: render the prompt, ask for JSON matching the prompt's schema, validate with
// zod, allow exactly one repair attempt, and record a trace span per attempt.
import type { Clock, EventSink, LLM, LlmResponse, Msg, Reasoning } from "../ports";
import { renderPrompt, schemaFor } from "../prompts";
import { PROMPT_OUTPUTS, type PromptName, type PromptOutput } from "../schemas";

export const REPAIR_MESSAGE = "Return only valid JSON matching the schema";

export class AgentError extends Error {
  constructor(
    readonly code: "bad_output",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentContext {
  llm: LLM;
  sink: EventSink;
  clock: Clock;
  /** Deterministic step name used for the trace (e.g. `judge:c1:s2`). */
  step: string;
}

export interface CallOptions {
  temperature: number;
  reasoning: Reasoning;
  maxTokens: number;
  seed?: number;
}

/** Output-token ceilings per prompt (laptop Qwen3 thinking for the judge needs headroom). */
export const MAX_TOKENS: Record<PromptName, number> = {
  decomposer: 2048,
  planner: 512,
  advocate: 768,
  skeptic: 768,
  judge: 3072,
  llm_only: 1536,
  single_agent: 1536,
};

/** Parses JSON from a model reply, tolerating ```json fences or prose around one JSON object. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*|\s*```$/g, "")];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export async function callJson<N extends PromptName>(
  ctx: AgentContext,
  prompt: N,
  values: Readonly<Record<string, string>>,
  opts: CallOptions,
): Promise<{ output: PromptOutput<N>; response: LlmResponse }> {
  const schema = PROMPT_OUTPUTS[prompt];
  const messages: Msg[] = renderPrompt(prompt, values);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = ctx.clock.now();
    const response = await ctx.llm.chat({
      task: prompt,
      messages,
      jsonSchema: schemaFor(prompt),
      temperature: opts.temperature,
      reasoning: opts.reasoning,
      maxTokens: opts.maxTokens,
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    });
    const parsed = schema.safeParse(response.json ?? extractJson(response.text));
    lastError = parsed.success
      ? ""
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    await ctx.sink.span({
      step: attempt === 0 ? ctx.step : `${ctx.step}:repair`,
      model: response.model,
      provider: response.provider,
      inTok: response.usage.input,
      outTok: response.usage.output,
      ...(response.neurons === undefined ? {} : { neurons: response.neurons }),
      ms: ctx.clock.now() - started,
      ok: parsed.success,
      ...(parsed.success ? {} : { error: `invalid output: ${lastError}`.slice(0, 300) }),
    });
    if (parsed.success) return { output: parsed.data as PromptOutput<N>, response };
    messages.push({ role: "assistant", content: response.text }, { role: "user", content: REPAIR_MESSAGE });
  }
  throw new AgentError("bad_output", `${prompt}: invalid JSON after one repair attempt (${lastError})`);
}
