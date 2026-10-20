// `npx satya report`: results/SUMMARY.md (the Project §9 tables) + results/benchmarks.json (web Benchmarks
// page). Only results produced under the current configuration (config hash) are reported; τ is the
// current tuned value, applied post hoc. Missing cells stay "—" — nothing is filled by hand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SYSTEMS, type SystemName } from "@satya/core";
import { laptopModelLabel, loadSharedConfig } from "../laptop-ports";
import type { SatyaStore } from "../store/sqlite";
import { DATASETS, type DatasetName, loadSplit } from "./datasets";
import { RESULTS_DIR, configHash, storedResults } from "./run-eval";
import { type RunSummary, summarize } from "./summary";

const MAIN: readonly SystemName[] = ["llm_only", "single_agent_rag", "satya_no_debate", "satya_full"];
const ABLATIONS: readonly SystemName[] = ["satya_full", "dense_only", "no_rerank", "rounds_1", "rounds_3"];
const NAMES: Record<SystemName, string> = {
  llm_only: "LLM-only (Qwen3-4B)",
  single_agent_rag: "Single-agent RAG (Qwen3-4B)",
  satya_no_debate: "Satya w/o debate (Qwen3-4B)",
  satya_full: "**Satya (Qwen3-4B, laptop)**",
  dense_only: "Satya, dense-only retrieval",
  no_rerank: "Satya, no re-ranker",
  rounds_1: "Satya, 1 debate round",
  rounds_3: "Satya, 3 debate rounds",
};

/**
 * Test-split summaries for every (dataset, system) with results under the current config. Within a dataset
 * every system is scored on the **same claims**: the claims all of them have finished (a run that also holds
 * extra claims, e.g. from an earlier smoke test, is cut to the common set).
 */
export async function collectSummaries(store: SatyaStore): Promise<RunSummary[]> {
  const tau = loadSharedConfig().pipeline.abstainThreshold;
  const out: RunSummary[] = [];
  for (const dataset of DATASETS) {
    const expected = (await loadSplit(dataset, "test")).length;
    const runs = SYSTEMS.map((system) => ({
      system,
      items: [...storedResults(store, `${dataset}:${system}:test:${configHash(system)}`).values()],
    })).filter((r) => r.items.length > 0);
    if (runs.length === 0) continue;
    const common = runs
      .map((r) => new Set(r.items.map((i) => i.id)))
      .reduce((acc, ids) => new Set([...acc].filter((id) => ids.has(id))));
    for (const { system, items } of runs) {
      const shared = items.filter((i) => common.has(i.id));
      const summary = summarize(shared, { dataset, system, split: "test", model: laptopModelLabel() }, tau);
      out.push(
        shared.length === expected ? summary : { ...summary, sample: { n: shared.length, of: expected } },
      );
    }
  }
  return out;
}

const sampleNote = (s: RunSummary | undefined) => (s?.sample ? ` (n = ${s.sample.n} of ${s.sample.of})` : "");
const ci = (s: RunSummary) => `${pct(s.accuracy)} [${pct(s.accuracyCI[0])}–${pct(s.accuracyCI[1])}]`;

const pct = (x: number | undefined) => (x === undefined ? "—" : (100 * x).toFixed(1));
const num = (x: number | undefined, d = 3) => (x === undefined ? "—" : x.toFixed(d));

function bestBold(
  values: (number | undefined)[],
  lowerIsBetter: boolean,
  fmt: (x: number | undefined) => string,
): string[] {
  const defined = values.filter((v): v is number => v !== undefined);
  const best = defined.length ? (lowerIsBetter ? Math.min(...defined) : Math.max(...defined)) : undefined;
  return values.map((v) => (v !== undefined && v === best && defined.length > 1 ? `**${fmt(v)}**` : fmt(v)));
}

export function renderSummary(
  summaries: readonly RunSummary[],
  tauRecord: unknown,
  generatedAt: string,
): string {
  const get = (dataset: DatasetName, system: SystemName) =>
    summaries.find((s) => s.dataset === dataset && s.system === system);
  const lines: string[] = [
    "# Satya — evaluation results",
    "",
    `Generated ${generatedAt} by \`npx satya report\` from \`results/*.jsonl\` (laptop: qwen3:4b + bge-m3 + bge-reranker-base). Test splits; τ = ${loadSharedConfig().pipeline.abstainThreshold} (tuned on dev, see below). Accuracy and macro-F1 use the final label (abstention = NOT_ENOUGH_INFO; on HoVer REFUTED/NEI count as NOT_SUPPORTED). ECE and AURC use the raw label and confidence. ECE/AURC/s per claim in the main table are on SciFact.`,
    "",
    "## Main comparison",
    "",
    `Every system is scored on the same claims of each dataset. Samples: ${DATASETS.map((d) => {
      const s = summaries.find((x) => x.dataset === d);
      return `${d} ${s ? (s.sample ? `n = ${s.sample.n} of ${s.sample.of}` : `all ${s.n}`) : "—"}`;
    }).join(", ")}. Accuracy 95 % bootstrap intervals are in the per-dataset tables.`,
    "",
    "| System | SciFact Acc | SciFact F1 | FEVER Acc | HoVer Acc | ECE ↓ | AURC ↓ | s/claim |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const cols = {
    sAcc: MAIN.map((s) => get("scifact", s)?.accuracy),
    sF1: MAIN.map((s) => get("scifact", s)?.macroF1),
    fAcc: MAIN.map((s) => get("fever", s)?.accuracy),
    hAcc: MAIN.map((s) => get("hover", s)?.accuracy),
    ece: MAIN.map((s) => get("scifact", s)?.ece),
    aurc: MAIN.map((s) => get("scifact", s)?.aurc),
    sec: MAIN.map((s) => get("scifact", s)?.secondsPerClaim.mean),
  };
  const b = {
    sAcc: bestBold(cols.sAcc, false, pct),
    sF1: bestBold(cols.sF1, false, pct),
    fAcc: bestBold(cols.fAcc, false, pct),
    hAcc: bestBold(cols.hAcc, false, pct),
    ece: bestBold(cols.ece, true, num),
    aurc: bestBold(cols.aurc, true, num),
  };
  MAIN.forEach((system, i) =>
    lines.push(
      `| ${NAMES[system]} | ${b.sAcc[i]} | ${b.sF1[i]} | ${b.fAcc[i]} | ${b.hAcc[i]} | ${b.ece[i]} | ${b.aurc[i]} | ${num(cols.sec[i], 1)} |`,
    ),
  );
  lines.push("| **Satya (gpt-oss-120b, deployed, 200-claim subset)** | — | — | — | — | — | — | — |", "");

  for (const dataset of DATASETS) {
    lines.push(
      `## ${dataset} (test) — all metrics`,
      "",
      "| System | n | Acc [95 % CI] | Macro-F1 | ECE | AURC | Coverage@τ | Sel. acc@τ | s/claim (mean / median) | LLM calls | Tokens in/out |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const s of summaries.filter((x) => x.dataset === dataset)) {
      lines.push(
        `| ${s.system}${sampleNote(s)} | ${s.n} | ${ci(s)} | ${pct(s.macroF1)} | ${num(s.ece)} | ${num(s.aurc)} | ${pct(s.selective.coverage)} | ${pct(s.selective.selectiveAccuracy)} | ${num(s.secondsPerClaim.mean, 1)} / ${num(s.secondsPerClaim.median, 1)} | ${num(s.llmCallsPerClaim, 1)} | ${Math.round(s.tokensPerClaim.input)} / ${Math.round(s.tokensPerClaim.output)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Ablations (SciFact test)",
    "",
    "| System | Acc | Macro-F1 | ECE | AURC | s/claim |",
    "|---|---|---|---|---|---|",
  );
  for (const system of ABLATIONS) {
    const s = get("scifact", system);
    lines.push(
      `| ${NAMES[system]} | ${pct(s?.accuracy)} | ${pct(s?.macroF1)} | ${num(s?.ece)} | ${num(s?.aurc)} | ${num(s?.secondsPerClaim.mean, 1)} |`,
    );
  }
  lines.push(
    "",
    "## τ tuning (dev)",
    "",
    "```json",
    JSON.stringify(tauRecord ?? "not tuned yet", null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}

export async function writeReport(store: SatyaStore): Promise<{ summaries: RunSummary[]; files: string[] }> {
  const summaries = await collectSummaries(store);
  const tauFile = `${RESULTS_DIR}/TAU.json`;
  const tauRecord = existsSync(tauFile) ? JSON.parse(readFileSync(tauFile, "utf8")) : null;
  const generatedAt = new Date().toISOString();
  writeFileSync(`${RESULTS_DIR}/SUMMARY.md`, renderSummary(summaries, tauRecord, generatedAt));
  writeFileSync(
    `${RESULTS_DIR}/benchmarks.json`,
    JSON.stringify({ generatedAt, tau: tauRecord, laptop: summaries }, null, 2) + "\n",
  );
  return { summaries, files: [`${RESULTS_DIR}/SUMMARY.md`, `${RESULTS_DIR}/benchmarks.json`] };
}
