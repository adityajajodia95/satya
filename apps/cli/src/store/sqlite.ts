// Laptop SQLite store (better-sqlite3): tool-result cache, Tavily monthly credit guard, and resumable
// evaluation results (one row per item, so an interrupted `eval --resume` continues where it stopped).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ToolDoc } from "@satya/core";
import type { CreditGuard, ToolCache } from "@satya/tools";
import { repoPath } from "../paths";

/** SATYA_DB overrides the database file (e.g. one per worker process on Kaggle). */
export const DEFAULT_DB = process.env.SATYA_DB ?? repoPath("data", "satya.sqlite");

export class SatyaStore {
  readonly db: Database.Database;

  constructor(file = DEFAULT_DB) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_cache (key TEXT PRIMARY KEY, docs TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credits (counter TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL,
                                          PRIMARY KEY (counter, month));
      CREATE TABLE IF NOT EXISTS eval_runs (id TEXT PRIMARY KEY, dataset TEXT NOT NULL, system TEXT NOT NULL,
                                            split TEXT NOT NULL, config_hash TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS eval_items (run_id TEXT NOT NULL, item_id TEXT NOT NULL, result TEXT NOT NULL,
                                             PRIMARY KEY (run_id, item_id));
    `);
  }

  toolCache(now: () => number = Date.now): ToolCache {
    const get = this.db.prepare<[string, number], { docs: string }>(
      "SELECT docs FROM tool_cache WHERE key = ? AND expires > ?",
    );
    const put = this.db.prepare("INSERT OR REPLACE INTO tool_cache (key, docs, expires) VALUES (?, ?, ?)");
    return {
      get: (key) => {
        const row = get.get(key, now());
        return Promise.resolve(row ? (JSON.parse(row.docs) as ToolDoc[]) : null);
      },
      put: (key, docs, ttlS) => {
        put.run(key, JSON.stringify(docs), now() + ttlS * 1000);
        return Promise.resolve();
      },
    };
  }

  /** Monthly counter that refuses once `limit` is reached (Tavily: 900 of the free 1,000 credits). */
  creditGuard(
    counter: string,
    limit: number,
    now: () => Date = () => new Date(),
  ): CreditGuard & { used(): number } {
    const month = () => now().toISOString().slice(0, 7);
    const read = this.db.prepare<[string, string], { used: number }>(
      "SELECT used FROM credits WHERE counter = ? AND month = ?",
    );
    const bump = this.db.prepare(
      "INSERT INTO credits (counter, month, used) VALUES (?, ?, 1) ON CONFLICT (counter, month) DO UPDATE SET used = used + 1",
    );
    const used = () => read.get(counter, month())?.used ?? 0;
    return {
      used,
      tryConsume: () => {
        const ok = this.db.transaction(() => {
          if (used() >= limit) return false;
          bump.run(counter, month());
          return true;
        })();
        return Promise.resolve(ok);
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
