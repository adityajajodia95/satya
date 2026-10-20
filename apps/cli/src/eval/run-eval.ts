// `npx satya eval --dataset scifact --system satya_full --split test --resume`: runs every item through the
// laptop pipeline (starting from the claim), stores one result per item in SQLite (resumable), and exports
// results/<dataset>_<system>_<split>_<ts>.jsonl + .summary.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type CorpusIndex,
  PIPELINE_ERROR,
  type Ports,
  type SourceChoice,
  type SystemName,
  initialState,
  runLocal,
  variantFor,
} from "@satya/core";
import { readJsonConfig } from "../config";
import { createLaptopPorts, laptopModelLabel, loadSharedConfig } from "../laptop-ports";
import { repoPath } from "../paths";
import { loadScifactIndex } from "../scifact-index";
import type { SatyaStore } from "../store/sqlite";
import { ProgressSink } from "../verify";
import {
  type DatasetName,
  type EvalItem,
  type Split,
  loadSplit,
  stratifiedSample,
  toDatasetLabel,
} from "./datasets";
import { type ItemResult, type RunSummary, summarize } from "./summary";

export const RESULTS_DIR = repoPath("results");

/** FEVER and HoVer were built from Wikipedia, so open-domain evaluation uses Wikipedia tools only (C7). */
export const EVAL_SOURCES: Record<DatasetName, SourceChoice[]> = {
  scifact: [],
  fever: ["wikipedia"],
  hover: ["wikipedia"],
};

/** Everything that changes model behaviour, except τ (applied post hoc). */
export function configHash(system: SystemName): string {
  const shared = loadSharedConfig();
  const { abstainThreshold: _tau, ...pipeline } = shared.pipeline;
  const prompts = readFileSync(repoPath("packages", "core", "src", "prompts.generated.ts"), "utf8");
  return createHash("sha1")
    .update(
      JSON.stringify({
        system,
        shared: { ...shared, pipeline },
        laptop: readJsonConfig("laptop.json"),
        prompts,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

interface EvalRunRow {
  id: string;
  created: string;
}

export function openRun(
  store: SatyaStore,
  dataset: DatasetName,
  system: SystemName,
  split: Split,
): EvalRunRow {
  const hash = configHash(system);
  const id = `${dataset}:${system}:${split}:${hash}`;
  store.db
    .prepare(
      "INSERT OR IGNORE INTO eval_runs (id, dataset, system, split, config_hash, created) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, dataset, system, split, hash, new Date().toISOString());
  return store.db
    .prepare<[string], EvalRunRow>("SELECT id, created FROM eval_runs WHERE id = ?")
    .get(id) as EvalRunRow;
}

export function storedResults(store: SatyaStore, runId: string): Map<string, ItemResult> {
  const rows = store.db
    .prepare<[string], { item_id: string; result: string }>(
      "SELECT item_id, result FROM eval_items WHERE run_id = ?",
    )
    .all(runId);
  return new Map(rows.map((r) => [r.item_id, JSON.parse(r.result) as ItemResult]));
}

async function evaluateItem(
  item: EvalItem,
  system: SystemName,
  base: Omit<Ports, "sink">,
  corpus: CorpusIndex | undefined,
): Promise<ItemResult> {
  const config = loadSharedConfig();
  const sink = new ProgressSink(true);
  const variant = variantFor(system, config, {
    decompose: false,
    evidence: item.dataset === "scifact" ? "corpus" : "tools",
  });
  const state = initialState({
    runId: item.id,
    text: item.claim,
    sources: EVAL_SOURCES[item.dataset],
    maxClaims: 1,
    variant,
  });
  const started = Date.now();
  const { state: final } = await runLocal(state, {
    config,
    ports: { ...base, sink },
    ...(corpus ? { corpus } : {}),
  });
  const cs = final.perClaim.c1!;
  const verdict = cs.verdict!;
  return {
    id: item.id,
    gold: item.gold,
    rawLabel: verdict.rawLabel,
    confidence: verdict.confidence,
    samples: verdict.samples,
    cited: verdict.cited.length,
    passages: cs.passageCount ?? 0,
    ms: Date.now() - started,
    llmCalls: sink.spans.length,
    repairs: sink.spans.filter((s) => s.step.endsWith(":repair")).length,
    inTok: sink.spans.reduce((n, s) => n + s.inTok, 0),
    outTok: sink.spans.reduce((n, s) => n + s.outTok, 0),
    ...(verdict.rationale === PIPELINE_ERROR
      ? { error: sink.errors.join("; ").slice(0, 300) || PIPELINE_ERROR }
      : {}),
  };
}

export interface EvalOptions {
  dataset: DatasetName;
  system: SystemName;
  split: Split;
  limit?: number;
  /** Seeded stratified subset of the split (preliminary runs); same run id, so a later full run resumes. */
  sample?: number;
  resume: boolean;
  concurrency?: number;
  log?: (line: string) => void;
}

export async function runEval(
  store: SatyaStore,
  opts: EvalOptions,
): Promise<{ summary: RunSummary; files: string[] }> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l));
  const split = await loadSplit(opts.dataset, opts.split);
  const items = (opts.sample ? stratifiedSample(split, opts.sample) : split).slice(0, opts.limit ?? Infinity);
  const run = openRun(store, opts.dataset, opts.system, opts.split);
  // Resumed results are limited to this item set (a run resumed with --sample may hold results for other
  // items), and items that ended in a pipeline error (e.g. Ollama down) are run again rather than kept.
  const ids = new Set(items.map((i) => i.id));
  const done = new Map(
    opts.resume ? [...storedResults(store, run.id)].filter(([id, r]) => ids.has(id) && !r.error) : [],
  );
  if (!opts.resume) store.db.prepare("DELETE FROM eval_items WHERE run_id = ?").run(run.id);
  const todo = items.filter((i) => !done.has(i.id));
  log(`${run.id}: ${items.length} items, ${done.size} already done, ${todo.length} to run\n`);

  const config = loadSharedConfig();
  const { sink: _sink, ...base } = createLaptopPorts(store, new ProgressSink(true), config);
  const corpus = opts.dataset === "scifact" && opts.system !== "llm_only" ? loadScifactIndex() : undefined;
  const save = store.db.prepare(
    "INSERT OR REPLACE INTO eval_items (run_id, item_id, result) VALUES (?, ?, ?)",
  );

  const started = Date.now();
  let finished = 0;
  let correct = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const result = await evaluateItem(item, opts.system, base, corpus);
      save.run(run.id, item.id, JSON.stringify(result));
      done.set(item.id, result);
      finished++;
      correct += toDatasetLabel(item.dataset, result.rawLabel) === item.gold ? 1 : 0;
      const perItem = (Date.now() - started) / finished / 1000;
      const eta = (perItem * (todo.length - finished)) / 60;
      log(
        `\r  ${done.size}/${items.length} · raw acc ${(correct / finished).toFixed(3)} · ${perItem.toFixed(1)} s/claim · ETA ${eta.toFixed(0)} min   `,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));
  if (todo.length) log("\n");

  const results = items.map((i) => done.get(i.id)).filter((r): r is ItemResult => r !== undefined);
  const summary = summarize(
    results,
    { dataset: opts.dataset, system: opts.system, split: opts.split, model: laptopModelLabel() },
    config.pipeline.abstainThreshold,
  );
  return { summary, files: exportRun(run, results, summary) };
}

/** results/<dataset>_<system>_<split>_<ts>.jsonl (+ .summary.json); ts = the run's creation time. */
export function exportRun(run: EvalRunRow, results: readonly ItemResult[], summary: RunSummary): string[] {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = run.created.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `${RESULTS_DIR}/${summary.dataset}_${summary.system}_${summary.split}_${ts}`;
  writeFileSync(`${base}.jsonl`, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(`${base}.summary.json`, JSON.stringify({ runId: run.id, ...summary }, null, 2) + "\n");
  return [`${base}.jsonl`, `${base}.summary.json`];
}
