// A fixed fake-LLM transcript + fake tools for the executor-parity golden test (§6.2, §8). Both the
// local runner (core tests) and the Workflow (worker tests, M9) must walk exactly GOLDEN_STEPS.
import type { LlmRequest, Tools } from "../ports";
import type { ToolDoc, ToolName, ToolResult } from "../schemas";
import { tokenize } from "../retrieval/bm25";
import { FakeLLM } from "./fakes";
import { TINY_CORPUS } from "./tiny-corpus";

export const GOLDEN_TEXT = "The Eiffel Tower was completed in 1889. It is located in Berlin.";

const lastUserMessage = (req: LlmRequest) =>
  req.messages.filter((m) => m.role === "user").at(0)?.content ?? "";
const isBerlin = (req: LlmRequest) => /CLAIM: .*Berlin/.test(lastUserMessage(req));

export function goldenLlm(): FakeLLM {
  return new FakeLLM({
    decomposer: {
      claims: [
        {
          text: "The Eiffel Tower was completed in 1889.",
          quote: "The Eiffel Tower was completed in 1889",
          checkworthy: true,
        },
        {
          text: "The Eiffel Tower is located in Berlin.",
          quote: "It is located in Berlin",
          checkworthy: true,
        },
      ],
    },
    planner: (req: LlmRequest) =>
      isBerlin(req)
        ? { queries: ["Eiffel Tower location", "Where is the Eiffel Tower?"], scientific: false }
        : {
            queries: ["Eiffel Tower completed 1889", "When was the Eiffel Tower completed?"],
            scientific: false,
          },
    advocate: { argument: "E1 describes the Eiffel Tower [E1].", cited: ["E1"] },
    skeptic: (req: LlmRequest) =>
      isBerlin(req)
        ? { argument: "E1 places the tower in Paris, not Berlin [E1].", cited: ["E1"] }
        : { argument: "E1 confirms the 1889 completion [E1].", cited: ["E1"] },
    judge: (req: LlmRequest) =>
      isBerlin(req)
        ? { label: "REFUTED", rationale: "E1 says Paris.", cited: ["E1"] }
        : { label: "SUPPORTED", rationale: "E1 says 1889.", cited: ["E1"] },
  });
}

const wikiDoc = (title: string, text: string): ToolDoc => ({
  source: "wikipedia",
  url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
  title,
  text,
  published: null,
});

/** Wikipedia over the tiny corpus: search = passages sharing ≥ 2 query tokens (top 2), page = full text. */
export class FakeTools implements Tools {
  readonly calls: { name: ToolName; args: object }[] = [];
  constructor(private readonly failing: ReadonlySet<ToolName> = new Set()) {}

  call(name: ToolName, args: object): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (this.failing.has(name)) {
      return Promise.resolve({
        ok: false,
        tool: name,
        error: { code: "rate_limited", message: "forced failure" },
      });
    }
    if (name === "wiki_search") {
      const q = new Set(tokenize((args as { query: string }).query));
      const docs = TINY_CORPUS.map((p) => ({
        p,
        overlap: tokenize(`${p.title} ${p.text}`).filter((t) => q.has(t)).length,
      }))
        .filter((x) => x.overlap >= 2)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 2)
        .map(({ p }) => wikiDoc(p.title, p.text.slice(0, 60)));
      return Promise.resolve({ ok: true, tool: name, docs, cached: false });
    }
    if (name === "wiki_page") {
      const page = TINY_CORPUS.find((p) => p.title === (args as { title: string }).title);
      return Promise.resolve(
        page
          ? { ok: true, tool: name, docs: [wikiDoc(page.title, page.text)], cached: false }
          : { ok: false, tool: name, error: { code: "not_found", message: "missing" } },
      );
    }
    return Promise.resolve({
      ok: false,
      tool: name,
      error: { code: "unavailable", message: `${name} not faked` },
    });
  }
}

/** The step sequence both executors must produce for GOLDEN_TEXT with the transcript above. */
export const GOLDEN_STEPS: readonly string[] = [
  "decompose",
  "plan:c1",
  "plan:c2",
  "search:c1:q1:wiki",
  "search:c1:q2:wiki",
  "search:c2:q1:wiki",
  "search:c2:q2:wiki",
  "fetch:c1:1",
  "fetch:c2:1",
  "embed:c1",
  "embed:c2",
  "rerank:c1",
  "rerank:c2",
  "argue:c1:r1:advocate",
  "argue:c2:r1:advocate",
  "argue:c1:r1:skeptic",
  "argue:c2:r1:skeptic",
  "argue:c1:r2:advocate",
  "argue:c2:r2:advocate",
  "argue:c1:r2:skeptic",
  "argue:c2:r2:skeptic",
  "judge:c1:s1",
  "judge:c1:s2",
  "judge:c1:s3",
  "judge:c2:s1",
  "judge:c2:s2",
  "judge:c2:s3",
  "verdict:c1",
  "verdict:c2",
  "aggregate",
];
