import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PromptError,
  placeholdersOf,
  render,
  renderEvidence,
  renderPrompt,
  renderTranscript,
  templateFor,
  truncate,
} from "../src/prompts";
import type { Argument, Evidence } from "../src/schemas";

describe("render", () => {
  it("fills placeholders", () => {
    expect(render("CLAIM: {claim}\nEVIDENCE:\n{evidence}", { claim: "A", evidence: "B" })).toBe(
      "CLAIM: A\nEVIDENCE:\nB",
    );
  });

  it("inserts values literally — braces in values are never treated as placeholders", () => {
    const out = render("CLAIM: {claim}\nEVIDENCE: {evidence}", {
      claim: "x {evidence} y",
      evidence: "{claim}}{",
    });
    expect(out).toBe("CLAIM: x {evidence} y\nEVIDENCE: {claim}}{");
  });

  it("truncates values over their limit with an ellipsis", () => {
    const out = render("T: {text}", { text: "abcdefghij" }, { text: 6 });
    expect(out).toBe("T: abcde…");
    expect(out.length - 3).toBe(6);
    expect(render("T: {text}", { text: "abcdef" }, { text: 6 })).toBe("T: abcdef");
  });

  it("throws on a missing placeholder value", () => {
    expect(() => render("{claim} {evidence}", { claim: "A" })).toThrow(PromptError);
    expect(() => render("{claim} {evidence}", { claim: "A" })).toThrow("{evidence}");
  });

  it("throws on an unexpected value (catches typos in callers)", () => {
    expect(() => render("{claim}", { claim: "A", claims: "B" })).toThrow("unexpected value for {claims}");
  });

  it("truncate never exceeds the limit", () => {
    for (const max of [1, 2, 5, 50]) expect(truncate("x".repeat(100), max).length).toBeLessThanOrEqual(max);
  });
});

describe("templates (kept exactly as the spec)", () => {
  it.each(["decomposer", "planner", "advocate", "skeptic", "judge"] as const)(
    "%s.md is byte-identical to the template in docs/Satya_Development.md",
    (name) => {
      const specUrl = new URL("../../../docs/Satya_Development.md", import.meta.url);
      const doc = readFileSync(specUrl, "utf8").replace(/\r\n/g, "\n");
      const block = doc.match(new RegExp("`" + name + "\\.md`\\n```\\n([\\s\\S]*?)\\n```"));
      expect(block?.[1]).toBeDefined();
      expect(templateFor(name)).toBe(block?.[1]);
    },
  );

  it.each([
    ["decomposer", ["text"]],
    ["planner", ["claim"]],
    ["advocate", ["claim", "evidence", "transcript"]],
    ["skeptic", ["claim", "evidence", "transcript"]],
    ["judge", ["claim", "evidence", "transcript"]],
    ["llm_only", ["claim"]],
    ["single_agent", ["claim", "evidence"]],
  ] as const)("%s uses placeholders %j", (name, expected) => {
    expect(placeholdersOf(templateFor(name))).toEqual(expected);
  });

  it("renderPrompt returns one user message ending with the JSON instruction", () => {
    const [msg] = renderPrompt("planner", { claim: "Water boils at 100 C at sea level." });
    expect(msg?.role).toBe("user");
    expect(msg?.content).toContain("CLAIM: Water boils at 100 C at sea level.");
    expect(msg?.content.endsWith("Return JSON only.")).toBe(true);
  });

  it("prompts.generated.ts is up to date with prompts/", () => {
    const script = fileURLToPath(new URL("../../../scripts/embed-prompts.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  }, 30_000); // runs the embed script
});

describe("evidence and transcript rendering", () => {
  const ev = (id: string, text: string): Evidence => ({
    id,
    passage: {
      id: id.toLowerCase(),
      source: "wikipedia",
      url: null,
      title: "Eiffel Tower",
      text,
      published: null,
    },
    bm25Rank: null,
    denseRank: null,
    rrf: 0,
    rerank: 0,
  });

  it("formats [E1] (source, title) text, truncated to evidenceChars", () => {
    const out = renderEvidence([ev("E1", "Completed in 1889."), ev("E2", "y".repeat(50))], 10);
    expect(out).toBe("[E1] (wikipedia, Eiffel Tower) Completed…\n[E2] (wikipedia, Eiffel Tower) yyyyyyyyy…");
    expect(renderEvidence([], 900)).toBe("(no evidence found)");
  });

  it("keeps only the last 2 turns per side", () => {
    const args: Argument[] = [1, 2, 3].flatMap((round) =>
      (["advocate", "skeptic"] as const).map((side) => ({
        claimId: "c1",
        side,
        round,
        text: `${side}${round}`,
        cited: [],
      })),
    );
    expect(renderTranscript(args)).toBe(
      [
        "Round 2 ADVOCATE: advocate2",
        "Round 2 SKEPTIC: skeptic2",
        "Round 3 ADVOCATE: advocate3",
        "Round 3 SKEPTIC: skeptic3",
      ].join("\n"),
    );
    expect(renderTranscript([])).toBe("(none yet)");
  });
});
