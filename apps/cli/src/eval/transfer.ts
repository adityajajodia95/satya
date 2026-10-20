// Moving evaluation results between machines (laptop ⇄ Kaggle): `satya export` writes one JSONL per run
// (header line = run row, then one item per line); `satya import` merges them. Items are keyed by
// (run id, item id) and the run id contains the config hash, so only identical configurations merge.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SatyaStore } from "../store/sqlite";

interface RunRow {
  id: string;
  dataset: string;
  system: string;
  split: string;
  config_hash: string;
  created: string;
}

export function exportAll(store: SatyaStore, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const runs = store.db.prepare<[], RunRow>("SELECT * FROM eval_runs").all();
  const items = store.db.prepare<[string], { item_id: string; result: string }>(
    "SELECT item_id, result FROM eval_items WHERE run_id = ?",
  );
  return runs.map((run) => {
    const file = join(dir, `${run.id.replace(/:/g, "__")}.jsonl`);
    const lines = [
      JSON.stringify({ run }),
      ...items.all(run.id).map((i) => JSON.stringify({ item: i.item_id, result: JSON.parse(i.result) })),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  });
}

export function importAll(store: SatyaStore, dir: string): { runs: number; items: number } {
  const addRun = store.db.prepare(
    "INSERT OR IGNORE INTO eval_runs (id, dataset, system, split, config_hash, created) VALUES (@id, @dataset, @system, @split, @config_hash, @created)",
  );
  const addItem = store.db.prepare(
    "INSERT OR IGNORE INTO eval_items (run_id, item_id, result) VALUES (?, ?, ?)",
  );
  let runs = 0;
  let items = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const [header, ...rest] = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const { run } = JSON.parse(header as string) as { run: RunRow };
    store.db.transaction(() => {
      runs += addRun.run(run).changes;
      for (const line of rest) {
        const { item, result } = JSON.parse(line) as { item: string; result: unknown };
        items += addItem.run(run.id, item, JSON.stringify(result)).changes;
      }
    })();
  }
  return { runs, items };
}
