import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROMPT_SCHEMAS, PROMPT_TEMPLATES } from "../src/prompts.generated";
import {
  Argument,
  Claim,
  Evidence,
  PROMPT_OUTPUTS,
  Passage,
  Report,
  RunEvent,
  Span,
  ToolResult,
  Verdict,
} from "../src/schemas";

const passage: Passage = {
  id: "3f786850e387550fdab836ed7e6dc881de23001b",
  source: "wikipedia",
  url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
  title: "Eiffel Tower",
  text: "The tower was completed in 1889 as the entrance arch to the World's Fair.",
  published: null,
};
const claim: Claim = {
  id: "c1",
  text: "The Eiffel Tower was completed in 1889.",
  quote: "completed in 1889",
  span: [22, 39],
  checkworthy: true,
};
const evidence: Evidence = {
  id: "E1",
  passage,
  bm25Rank: 1,
  denseRank: 2,
  rrf: 1 / 61 + 1 / 62,
  rerank: 7.2,
};
const argument: Argument = {
  claimId: "c1",
  side: "advocate",
  round: 1,
  text: "E1 says 1889 [E1].",
  cited: ["E1"],
};
const verdict: Verdict = {
  claimId: "c1",
  label: "SUPPORTED",
  rawLabel: "SUPPORTED",
  confidence: 0.92,
  abstained: false,
  rationale: "E1 states the completion year.",
  cited: ["E1"],
  samples: ["SUPPORTED", "SUPPORTED", "SUPPORTED"],
};
const span: Span = {
  step: "judge:c1:s1",
  model: "qwen3:4b",
  provider: "ollama",
  inTok: 900,
  outTok: 80,
  ms: 2100,
  ok: true,
};

const roundTrip = <T>(schema: z.ZodType<T>, value: T) => schema.parse(JSON.parse(JSON.stringify(value)));

describe("schemas round-trip through JSON", () => {
  it.each([
    ["Passage", Passage, passage],
    ["Claim", Claim, claim],
    ["Evidence", Evidence, evidence],
    ["Argument", Argument, argument],
    ["Verdict", Verdict, verdict],
    ["Span", Span, span],
    ["RunEvent", RunEvent, { seq: 3, ts: 1_760_000_000_000, type: "verdict", data: verdict }],
  ] as const)("%s", (_name, schema, value) => {
    expect(roundTrip(schema as z.ZodType<unknown>, value)).toEqual(value);
  });

  it("Report (partial defaults to false)", () => {
    const report = {
      runId: "r1",
      inputText: "The Eiffel Tower was completed in 1889.",
      claims: [claim],
      evidence: { c1: [evidence] },
      debate: { c1: [argument] },
      verdicts: { c1: verdict },
      factuality: 1,
      trace: [span],
      model: "qwen3:4b",
      provider: "ollama",
      createdAt: "2026-10-13T12:00:00.000Z",
      executor: "laptop" as const,
    };
    const parsed = Report.parse(JSON.parse(JSON.stringify(report)));
    expect(parsed.partial).toBe(false);
    expect(parsed).toEqual({ ...report, partial: false });
  });

  it("ToolResult is a discriminated union", () => {
    const ok = { ok: true, tool: "wiki_search", docs: [{ ...passage, id: undefined }], cached: false };
    expect(ToolResult.parse(ok).ok).toBe(true);
    const err = { ok: false, tool: "scholar_search", error: { code: "rate_limited", message: "429" } };
    expect(ToolResult.parse(err)).toEqual(err);
  });
});

describe("schemas reject invalid data", () => {
  it("rejects unknown labels, bad evidence ids and out-of-range confidence", () => {
    expect(Verdict.safeParse({ ...verdict, label: "TRUE" }).success).toBe(false);
    expect(Verdict.safeParse({ ...verdict, confidence: 1.2 }).success).toBe(false);
    expect(Argument.safeParse({ ...argument, cited: ["E0"] }).success).toBe(false);
    expect(Argument.safeParse({ ...argument, cited: ["[E1]"] }).success).toBe(false);
    expect(Passage.safeParse({ ...passage, source: "blog" }).success).toBe(false);
    expect(Claim.safeParse({ ...claim, span: [1] }).success).toBe(false);
  });
});

describe("prompt output contracts", () => {
  it("every contract has a template and a JSON schema", () => {
    expect(Object.keys(PROMPT_TEMPLATES).sort()).toEqual(Object.keys(PROMPT_OUTPUTS).sort());
    expect(Object.keys(PROMPT_SCHEMAS).sort()).toEqual(Object.keys(PROMPT_OUTPUTS).sort());
  });

  it.each(Object.keys(PROMPT_OUTPUTS))("%s.schema.json matches its zod contract", (name) => {
    const { $schema: _ignored, ...fromZod } = z.toJSONSchema(
      PROMPT_OUTPUTS[name as keyof typeof PROMPT_OUTPUTS],
    );
    expect(PROMPT_SCHEMAS[name as keyof typeof PROMPT_SCHEMAS]).toEqual(fromZod);
  });

  it("JSON schemas are strict-mode compatible (every property required, no extras)", () => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      if (n.type === "object") {
        expect(n).toHaveProperty("additionalProperties", false);
        expect([...(n.required ?? [])].sort()).toEqual(Object.keys(n.properties ?? {}).sort());
      }
      Object.values(n).forEach(visit);
    };
    Object.values(PROMPT_SCHEMAS).forEach(visit);
  });
});
