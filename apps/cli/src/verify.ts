// `satya verify "<text>"`: the full pipeline on the laptop, printed as a table (or the Report as JSON).
import { randomUUID } from "node:crypto";
import { styleText } from "node:util";
import Table from "cli-table3";
import {
  type CorpusIndex,
  type EventSink,
  type Report,
  type RunEvent,
  type SourceChoice,
  type Span,
  buildReport,
  initialState,
  runLocal,
  summarize,
  variantFor,
} from "@satya/core";
import { createLaptopPorts, laptopModelLabel, loadSharedConfig } from "./laptop-ports";
import type { SatyaStore } from "./store/sqlite";

/** Collects spans for the report and prints a one-line progress update per frontier to stderr. */
export class ProgressSink implements EventSink {
  readonly spans: Span[] = [];
  /** Step errors reported by the runner (e.g. "judge:c1:s1: fetch failed"), for diagnosis. */
  readonly errors: string[] = [];
  constructor(private readonly quiet = false) {}
  emit(e: Omit<RunEvent, "seq" | "ts">): Promise<void> {
    const error = (e.data as { error?: unknown } | null)?.error;
    if (e.type === "verdict" && typeof error === "string") this.errors.push(error);
    if (!this.quiet && e.type === "stage") {
      const d = e.data as { step: number; of: number; last: string };
      process.stderr.write(`\r  step ${d.step} of ~${d.of}  ${d.last.padEnd(28)}`);
    }
    if (!this.quiet && e.type === "run_completed") process.stderr.write("\n");
    return Promise.resolve();
  }
  span(s: Span): Promise<void> {
    this.spans.push(s);
    return Promise.resolve();
  }
}

export interface VerifyOptions {
  sources: SourceChoice[];
  corpus?: CorpusIndex;
  quiet?: boolean;
}

export async function verifyText(store: SatyaStore, text: string, opts: VerifyOptions): Promise<Report> {
  const config = loadSharedConfig();
  const sink = new ProgressSink(opts.quiet);
  const ports = createLaptopPorts(store, sink, config);
  const variant = variantFor("satya_full", config, {
    decompose: true,
    evidence: opts.corpus ? "corpus" : "tools",
  });
  const state = initialState({
    runId: randomUUID(),
    text,
    sources: opts.sources,
    maxClaims: config.pipeline.maxClaims,
    variant,
  });
  const { state: final } = await runLocal(state, {
    config,
    ports,
    ...(opts.corpus ? { corpus: opts.corpus } : {}),
  });
  return buildReport(final, sink.spans, {
    model: laptopModelLabel(),
    provider: "ollama",
    createdAt: new Date().toISOString(),
    executor: "laptop",
  });
}

const VERDICT_STYLE = { SUPPORTED: "green", REFUTED: "red", NOT_ENOUGH_INFO: "yellow" } as const;

/** Human-readable report: one row per claim with verdict, confidence and the cited sources. */
export function formatReport(report: Report, color = true): string {
  const table = new Table({
    head: ["#", "Claim", "Verdict", "Conf.", "Cited evidence"],
    colWidths: [5, 46, 18, 7, 44],
    wordWrap: true,
    style: { head: color ? ["bold"] : [] },
  });
  for (const claim of report.claims.filter((c) => c.checkworthy)) {
    const v = report.verdicts[claim.id];
    if (!v) continue;
    const label =
      v.abstained && v.rawLabel !== v.label ? `${v.label} (abstained; raw ${v.rawLabel})` : v.label;
    const evidence = report.evidence[claim.id] ?? [];
    const cited = v.cited
      .map((id) => evidence.find((e) => e.id === id))
      .filter((e) => e !== undefined)
      .map((e) => `${e.id} ${e.passage.source}: ${e.passage.title}`)
      .join("\n");
    table.push([
      claim.id,
      claim.text,
      color ? styleText(VERDICT_STYLE[v.label], label) : label,
      v.confidence.toFixed(2),
      cited || (v.rationale === "pipeline error" || v.rationale === "capacity" ? v.rationale : "-"),
    ]);
  }
  const s = summarize(Object.values(report.verdicts));
  const factuality = s.factuality === null ? "n/a" : `${Math.round(s.factuality * 100)}%`;
  const llmCalls = report.trace.length;
  return [
    table.toString(),
    `${s.claims} claims · ${s.supported} supported · ${s.refuted} refuted · ${s.notEnoughInfo} not enough info · factuality ${factuality}`,
    `model ${report.model} (${report.provider}) · ${llmCalls} LLM calls`,
  ].join("\n");
}
