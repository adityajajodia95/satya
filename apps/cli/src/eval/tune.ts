// `npx satya tune`: τ on the dev split (satya_full, pooled datasets) maximising selective accuracy subject to
// coverage ≥ 0.7 (§7 M7, Project §14 Q4) → configs/default.json `pipeline.abstainThreshold` + results/TAU.json.
import { readFileSync, writeFileSync } from "node:fs";
import { tuneThreshold } from "@satya/core";
import { repoPath } from "../paths";
import type { SatyaStore } from "../store/sqlite";
import { type DatasetName, toDatasetLabel } from "./datasets";
import { RESULTS_DIR, configHash, storedResults } from "./run-eval";

export const MIN_COVERAGE = 0.7;

export function tune(store: SatyaStore, datasets: readonly DatasetName[], minCoverage = MIN_COVERAGE) {
  const hash = configHash("satya_full");
  const confidence: number[] = [];
  const correct: boolean[] = [];
  const used: Record<string, number> = {};
  for (const dataset of datasets) {
    const runId = `${dataset}:satya_full:dev:${hash}`;
    const items = [...storedResults(store, runId).values()];
    if (items.length === 0)
      throw new Error(
        `no dev results for ${runId} — run: npx satya eval --dataset ${dataset} --system satya_full --split dev`,
      );
    used[dataset] = items.length;
    for (const r of items) {
      confidence.push(r.confidence);
      correct.push(toDatasetLabel(dataset, r.rawLabel) === r.gold);
    }
  }
  const best = tuneThreshold(confidence, correct, minCoverage);
  const tau = Math.round(best.tau * 10_000) / 10_000;

  const configFile = repoPath("configs", "default.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { pipeline: { abstainThreshold: number } };
  const previous = config.pipeline.abstainThreshold;
  config.pipeline.abstainThreshold = tau;
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  const record = {
    tau,
    previous,
    minCoverage,
    coverage: best.coverage,
    selectiveAccuracy: best.selectiveAccuracy,
    answered: best.answered,
    tauExact: best.tau,
    devItems: used,
    configHash: hash,
    tunedAt: new Date().toISOString(),
  };
  writeFileSync(`${RESULTS_DIR}/TAU.json`, JSON.stringify(record, null, 2) + "\n");
  return record;
}
