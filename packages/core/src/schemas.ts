// Data contracts (Satya_Development.md §6.1). Every value that crosses a boundary — LLM output, tool
// output, the Worker API, stored reports — is validated with these zod schemas.
import { z } from "zod";

export const Label = z.enum(["SUPPORTED", "REFUTED", "NOT_ENOUGH_INFO"]);
export type Label = z.infer<typeof Label>;

export const SourceKind = z.enum(["web", "wikipedia", "arxiv", "scholar", "corpus"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const ToolName = z.enum([
  "web_search",
  "wiki_search",
  "wiki_page",
  "arxiv_search",
  "scholar_search",
  "fetch_url",
]);
export type ToolName = z.infer<typeof ToolName>;

export const Claim = z.object({
  id: z.string(),
  text: z.string(),
  quote: z.string(),
  span: z.tuple([z.number().int(), z.number().int()]).nullable(),
  checkworthy: z.boolean(),
});
export type Claim = z.infer<typeof Claim>;

export const Passage = z.object({
  id: z.string(), // sha1(url + chunk index)
  source: SourceKind,
  url: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  published: z.string().nullable(),
});
export type Passage = z.infer<typeof Passage>;

export const EvidenceId = z.string().regex(/^E[1-9]\d*$/);

export const Evidence = z.object({
  id: EvidenceId,
  passage: Passage,
  bm25Rank: z.number().int().nullable(),
  denseRank: z.number().int().nullable(),
  rrf: z.number(),
  rerank: z.number(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Side = z.enum(["advocate", "skeptic"]);
export type Side = z.infer<typeof Side>;

export const Argument = z.object({
  claimId: z.string(),
  side: Side,
  round: z.number().int().positive(),
  text: z.string(),
  cited: z.array(EvidenceId),
});
export type Argument = z.infer<typeof Argument>;

export const Verdict = z.object({
  claimId: z.string(),
  label: Label,
  rawLabel: Label,
  confidence: z.number().min(0).max(1),
  abstained: z.boolean(),
  rationale: z.string(),
  cited: z.array(EvidenceId),
  samples: z.array(Label),
});
export type Verdict = z.infer<typeof Verdict>;

export const Span = z.object({
  step: z.string(),
  model: z.string(),
  provider: z.string(),
  inTok: z.number().int().nonnegative(),
  outTok: z.number().int().nonnegative(),
  neurons: z.number().nonnegative().optional(),
  ms: z.number().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type Span = z.infer<typeof Span>;

export const Executor = z.enum(["laptop", "cloud"]);

export const Report = z.object({
  runId: z.string(),
  inputText: z.string(),
  claims: z.array(Claim),
  evidence: z.record(z.string(), z.array(Evidence)),
  debate: z.record(z.string(), z.array(Argument)),
  verdicts: z.record(z.string(), Verdict),
  factuality: z.number().min(0).max(1).nullable(),
  trace: z.array(Span),
  model: z.string(),
  provider: z.string(),
  createdAt: z.string(),
  executor: Executor,
  /** §7 M9: set when capacity ran out mid-run and remaining claims were not checked. */
  partial: z.boolean().default(false),
});
export type Report = z.infer<typeof Report>;

export const RunEventType = z.enum([
  "run_started",
  "stage",
  "claims",
  "queries",
  "tool_call",
  "evidence",
  "argument",
  "verdict",
  "run_completed",
  "run_failed",
  "capacity",
]);
export type RunEventType = z.infer<typeof RunEventType>;

export const RunEvent = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  type: RunEventType,
  data: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEvent>;

// ── Tool results ───────────────────────────────────────────────────────────────────────────────────
// Every tool returns documents in one shape (search hits carry their snippet/abstract as `text`, page
// tools carry the page text), or a friendly error object — tools never throw (§7 M2).

export const ToolDoc = z.object({
  source: SourceKind,
  url: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  published: z.string().nullable(),
});
export type ToolDoc = z.infer<typeof ToolDoc>;

export const ToolErrorCode = z.enum([
  "rate_limited",
  "timeout",
  "blocked",
  "not_found",
  "bad_response",
  "quota",
  "network",
  "unavailable",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), tool: ToolName, docs: z.array(ToolDoc), cached: z.boolean() }),
  z.object({
    ok: z.literal(false),
    tool: ToolName,
    error: z.object({ code: ToolErrorCode, message: z.string() }),
  }),
]);
export type ToolResult = z.infer<typeof ToolResult>;

// ── LLM output contracts (one per prompt; mirrored by prompts/*.schema.json) ───────────────────────

export const DecomposerOutput = z.object({
  claims: z.array(z.object({ text: z.string(), quote: z.string(), checkworthy: z.boolean() })),
});
export const PlannerOutput = z.object({ queries: z.array(z.string()), scientific: z.boolean() });
export const DebaterOutput = z.object({ argument: z.string(), cited: z.array(z.string()) });
export const JudgeOutput = z.object({ label: Label, rationale: z.string(), cited: z.array(z.string()) });
export const LlmOnlyOutput = z.object({ label: Label, rationale: z.string(), confidence: z.number() });
export const SingleAgentOutput = z.object({
  label: Label,
  rationale: z.string(),
  cited: z.array(z.string()),
  confidence: z.number(),
});

export const PROMPT_OUTPUTS = {
  decomposer: DecomposerOutput,
  planner: PlannerOutput,
  advocate: DebaterOutput,
  skeptic: DebaterOutput,
  judge: JudgeOutput,
  llm_only: LlmOnlyOutput,
  single_agent: SingleAgentOutput,
} as const;
export type PromptName = keyof typeof PROMPT_OUTPUTS;
export type PromptOutput<N extends PromptName> = z.infer<(typeof PROMPT_OUTPUTS)[N]>;
