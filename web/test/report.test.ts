import type { RunEvent } from "@satya/core";
import { describe, expect, it } from "vitest";
import { highlightSegments, queryTerms } from "../src/lib/report";
import { type LiveRun, applyEvent, stageOf } from "../src/lib/useRun";

const hits = (text: string, terms: string[]) =>
  highlightSegments(text, terms)
    .filter((s) => s.hit)
    .map((s) => s.text);

describe("evidence highlighting", () => {
  it("marks whole words only, case-insensitively", () => {
    expect(hits("The human brain houses only uses; Use it.", ["use", "only"])).toEqual(["only", "Use"]);
    expect(hits("A percentage, not a percent.", ["percent"])).toEqual(["percent"]);
  });
  it("works for non-Latin scripts and leaves the text intact", () => {
    const text = "सत्य और असत्य";
    expect(hits(text, ["सत्य"])).toEqual(["सत्य"]);
    expect(
      highlightSegments(text, ["सत्य"])
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
  it("query terms drop stop words and short tokens", () => {
    expect(queryTerms("The Eiffel Tower is in Paris.")).toEqual(["eiffel", "tower", "paris"]);
  });
});

describe("live run event folding", () => {
  const base: LiveRun = {
    runId: "r",
    status: "running",
    progress: null,
    stage: "claims",
    capacityHit: false,
    error: null,
    report: {
      runId: "r",
      inputText: "x",
      claims: [],
      evidence: {},
      debate: {},
      verdicts: {},
      factuality: null,
      trace: [],
      model: "m",
      provider: "workersai",
      createdAt: "2026-10-14T00:00:00Z",
      executor: "cloud",
      partial: false,
    },
  };
  const ev = (type: string, data: unknown, seq = 1) => ({ seq, ts: 0, type, data }) as RunEvent;

  it("maps step names to stages", () => {
    expect(
      ["decompose", "search:c1", "argue:c1:r1:advocate", "judge:c1:s0", "aggregate"].map(stageOf),
    ).toEqual(["claims", "evidence", "debate", "judge", "done"]);
  });
  it("folds claims, verdicts, capacity and failure", () => {
    let run = applyEvent(base, ev("claims", { claims: [{ id: "c1", text: "t", checkworthy: true }] }));
    expect(run.report.claims).toHaveLength(1);
    run = applyEvent(run, ev("verdict", { claimId: "c1", label: "SUPPORTED", confidence: 0.9 }));
    expect(run.report.verdicts.c1?.label).toBe("SUPPORTED");
    expect(applyEvent(run, ev("capacity", {})).capacityHit).toBe(true);
    const failed = applyEvent(run, ev("run_failed", { message: "boom" }));
    expect([failed.status, failed.error]).toEqual(["failed", "boom"]);
  });
});
