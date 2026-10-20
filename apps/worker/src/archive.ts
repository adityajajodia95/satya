// ArchiveDO (singleton, §7 M9): runs index, report cache (input hash → run), tool-result cache (72 h),
// Tavily monthly counter, and the parity queue/results.
import { DurableObject } from "cloudflare:workers";
import type { ToolDoc } from "@satya/core";
import type { SatyaEnv } from "./env";

export interface RunRow {
  id: string;
  created: number;
  preview: string;
  factuality: number | null;
  nClaims: number;
  status: "running" | "done" | "partial" | "failed";
  model: string;
  provider: string;
}

export interface ParityItem {
  id: string;
  dataset: "scifact" | "fever" | "hover";
  claim: string;
  gold: string;
  /** SciFact only: the laptop's top-20 closed-corpus chunks (C2). */
  passages?: { id: string; title: string; text: string }[];
}

export class ArchiveDO extends DurableObject<SatyaEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SatyaEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created INTEGER NOT NULL, preview TEXT NOT NULL, factuality REAL,
        n_claims INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
        input_hash TEXT NOT NULL, owner TEXT);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_cache (key TEXT PRIMARY KEY, docs TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credits (counter TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (counter, month));
      CREATE TABLE IF NOT EXISTS parity_queue (id TEXT PRIMARY KEY, payload TEXT NOT NULL, enqueued INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT);
      CREATE TABLE IF NOT EXISTS parity_results (id TEXT PRIMARY KEY, result TEXT NOT NULL, finished INTEGER NOT NULL);
    `);
  }

  // ── runs ────────────────────────────────────────────────────────────────────────────────────────

  addRun(r: {
    id: string;
    preview: string;
    model: string;
    provider: string;
    inputHash: string;
    owner: string | null;
    now?: number;
  }): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO runs (id, created, preview, status, model, provider, input_hash, owner) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)",
      r.id,
      r.now ?? Date.now(),
      r.preview.slice(0, 80),
      r.model,
      r.provider,
      r.inputHash,
      r.owner,
    );
  }

  completeRun(id: string, factuality: number | null, nClaims: number, status: RunRow["status"]): void {
    this.sql.exec(
      "UPDATE runs SET factuality = ?, n_claims = ?, status = ? WHERE id = ?",
      factuality,
      nClaims,
      status,
      id,
    );
  }

  /** Previews for the given ids (the browser keeps the ids of its own runs; C5). */
  runs(ids: string[]): RunRow[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    return this.sql
      .exec<{
        id: string;
        created: number;
        preview: string;
        factuality: number | null;
        n_claims: number;
        status: RunRow["status"];
        model: string;
        provider: string;
      }>(
        `SELECT id, created, preview, factuality, n_claims, status, model, provider FROM runs WHERE id IN (${marks}) ORDER BY created DESC`,
        ...ids.slice(0, 100),
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        created: r.created,
        preview: r.preview,
        factuality: r.factuality,
        nClaims: r.n_claims,
        status: r.status,
        model: r.model,
        provider: r.provider,
      }));
  }

  /** Only the session that created a run may delete it (C5). Returns false when not allowed. */
  deleteRun(id: string, owner: string): boolean {
    const row = this.sql
      .exec<{ owner: string | null }>("SELECT owner FROM runs WHERE id = ?", id)
      .toArray()[0];
    if (!row || !row.owner || row.owner !== owner) return false;
    this.sql.exec("DELETE FROM runs WHERE id = ?", id);
    this.sql.exec("DELETE FROM cache WHERE run_id = ?", id);
    return true;
  }

  // ── report cache (input hash → run id) ─────────────────────────────────────────────────────────

  cacheGet(key: string, now = Date.now()): string | null {
    const row = this.sql
      .exec<{ run_id: string; expires: number }>("SELECT run_id, expires FROM cache WHERE key = ?", key)
      .toArray()[0];
    return row && row.expires > now ? row.run_id : null;
  }

  cachePut(key: string, runId: string, ttlDays: number, now = Date.now()): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO cache (key, run_id, expires) VALUES (?, ?, ?)",
      key,
      runId,
      now + ttlDays * 86_400_000,
    );
  }

  // ── tool cache (72 h) and Tavily credits ────────────────────────────────────────────────────────

  toolGet(key: string, now = Date.now()): ToolDoc[] | null {
    const row = this.sql
      .exec<{ docs: string; expires: number }>("SELECT docs, expires FROM tool_cache WHERE key = ?", key)
      .toArray()[0];
    return row && row.expires > now ? (JSON.parse(row.docs) as ToolDoc[]) : null;
  }

  toolPut(key: string, docs: ToolDoc[], ttlS: number, now = Date.now()): void {
    const json = JSON.stringify(docs);
    if (json.length > 512 * 1024) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO tool_cache (key, docs, expires) VALUES (?, ?, ?)",
      key,
      json,
      now + ttlS * 1000,
    );
  }

  creditTryConsume(counter: string, limit: number, now = Date.now()): boolean {
    const month = new Date(now).toISOString().slice(0, 7);
    const used =
      this.sql
        .exec<{ used: number }>("SELECT used FROM credits WHERE counter = ? AND month = ?", counter, month)
        .toArray()[0]?.used ?? 0;
    if (used >= limit) return false;
    this.sql.exec(
      "INSERT INTO credits (counter, month, used) VALUES (?, ?, 1) ON CONFLICT (counter, month) DO UPDATE SET used = used + 1",
      counter,
      month,
    );
    return true;
  }

  // ── parity queue ────────────────────────────────────────────────────────────────────────────────

  parityEnqueue(items: ParityItem[], now = Date.now()): number {
    const count = () => this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM parity_queue").one().n;
    const before = count();
    for (const item of items) {
      this.sql.exec(
        "INSERT OR IGNORE INTO parity_queue (id, payload, enqueued, state) VALUES (?, ?, ?, 'queued')",
        item.id,
        JSON.stringify(item),
        now,
      );
    }
    return count() - before;
  }

  /** Next queued item (marked running), or null. */
  parityNext(runId: string): ParityItem | null {
    const row = this.sql
      .exec<{ id: string; payload: string }>(
        "SELECT id, payload FROM parity_queue WHERE state = 'queued' ORDER BY enqueued, id LIMIT 1",
      )
      .toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE parity_queue SET state = 'running', run_id = ? WHERE id = ?", runId, row.id);
    return JSON.parse(row.payload) as ParityItem;
  }

  parityDone(id: string, result: object, now = Date.now()): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO parity_results (id, result, finished) VALUES (?, ?, ?)",
      id,
      JSON.stringify(result),
      now,
    );
    this.sql.exec("UPDATE parity_queue SET state = 'done' WHERE id = ?", id);
  }

  /** Puts an item back (e.g. the nightly window closed or capacity ran out mid-item). */
  parityRequeue(id: string): void {
    this.sql.exec("UPDATE parity_queue SET state = 'queued', run_id = NULL WHERE id = ?", id);
  }

  parityResults(): object[] {
    return this.sql
      .exec<{ result: string }>("SELECT result FROM parity_results ORDER BY finished")
      .toArray()
      .map((r) => JSON.parse(r.result) as object);
  }

  parityCounts(): Record<string, number> {
    const rows = this.sql
      .exec<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM parity_queue GROUP BY state")
      .toArray();
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
