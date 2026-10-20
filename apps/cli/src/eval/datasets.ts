// Evaluation datasets (§2B, §7 M7): SciFact (all 1,109 labelled claims), FEVER dev (600 balanced, 200 per
// label, seed 13), HoVer validation (300, 150/150, seed 13); each split 30 % dev / 70 % test (seed 13,
// stratified by label so both splits keep the label mix).
import { readFileSync } from "node:fs";
import type { Label } from "@satya/core";
import { parquetReadObjects } from "hyparquet";
import { repoPath } from "../paths";

export const DATASETS = ["scifact", "fever", "hover"] as const;
export type DatasetName = (typeof DATASETS)[number];
export type BinaryLabel = "SUPPORTED" | "NOT_SUPPORTED";
export type GoldLabel = Label | BinaryLabel;
export type Split = "dev" | "test" | "all";

export interface EvalItem {
  id: string;
  dataset: DatasetName;
  claim: string;
  gold: GoldLabel;
}

export const SEED = 13;
export const LABELS: Record<DatasetName, readonly GoldLabel[]> = {
  scifact: ["SUPPORTED", "REFUTED", "NOT_ENOUGH_INFO"],
  fever: ["SUPPORTED", "REFUTED", "NOT_ENOUGH_INFO"],
  hover: ["SUPPORTED", "NOT_SUPPORTED"],
};

/** mulberry32: small, fast, seedable PRNG (deterministic across platforms). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `perLabel` items of each label, chosen by a seeded shuffle within each label group. */
export function balancedSample(items: readonly EvalItem[], perLabel: number, seed: number): EvalItem[] {
  const groups = new Map<GoldLabel, EvalItem[]>();
  for (const it of items) groups.set(it.gold, [...(groups.get(it.gold) ?? []), it]);
  return [...groups.keys()].sort().flatMap((label) => {
    const group = groups.get(label) as EvalItem[];
    if (group.length < perLabel) throw new Error(`only ${group.length} items labelled ${label}`);
    return seededShuffle(group, seed).slice(0, perLabel);
  });
}

/** Stratified 30 % dev / 70 % test split (rounded per label). */
export function splitItems(
  items: readonly EvalItem[],
  seed = SEED,
  devShare = 0.3,
): { dev: EvalItem[]; test: EvalItem[] } {
  const dev: EvalItem[] = [];
  const test: EvalItem[] = [];
  const labels = [...new Set(items.map((i) => i.gold))].sort();
  for (const label of labels) {
    const group = seededShuffle(
      items.filter((i) => i.gold === label),
      seed,
    );
    const nDev = Math.round(group.length * devShare);
    dev.push(...group.slice(0, nDev));
    test.push(...group.slice(nDev));
  }
  const byId = (a: EvalItem, b: EvalItem) => a.id.localeCompare(b.id, "en", { numeric: true });
  return { dev: dev.sort(byId), test: test.sort(byId) };
}

/**
 * Seeded stratified sample of `n` items (label proportions kept, rounded). Sampling only selects which
 * items run first — results live in the same resumable run, so a later full run reuses them.
 */
export function stratifiedSample(items: readonly EvalItem[], n: number, seed = SEED): EvalItem[] {
  if (n >= items.length) return [...items];
  const labels = [...new Set(items.map((i) => i.gold))].sort();
  const picked = labels.flatMap((label) => {
    const group = items.filter((i) => i.gold === label);
    return seededShuffle(group, seed).slice(0, Math.round((group.length / items.length) * n));
  });
  return picked.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

// ── loaders ───────────────────────────────────────────────────────────────────────────────────────

const jsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, { label: "SUPPORT" | "CONTRADICT" }[]>;
}

/** Claim-level label: any SUPPORT → SUPPORTED, any CONTRADICT → REFUTED, none → NEI (§2B). */
export function scifactLabel(evidence: SciFactClaim["evidence"]): Label {
  const labels = new Set(Object.values(evidence).flatMap((sentences) => sentences.map((e) => e.label)));
  if (labels.has("SUPPORT")) return "SUPPORTED";
  if (labels.has("CONTRADICT")) return "REFUTED";
  return "NOT_ENOUGH_INFO";
}

export function loadSciFact(dir = repoPath("data", "raw", "data")): EvalItem[] {
  return ["claims_train.jsonl", "claims_dev.jsonl"].flatMap((file) =>
    jsonl<SciFactClaim>(`${dir}/${file}`).map((c) => ({
      id: `scifact:${c.id}`,
      dataset: "scifact" as const,
      claim: c.claim,
      gold: scifactLabel(c.evidence),
    })),
  );
}

const FEVER_LABELS: Record<string, Label> = {
  SUPPORTS: "SUPPORTED",
  REFUTES: "REFUTED",
  "NOT ENOUGH INFO": "NOT_ENOUGH_INFO",
};

export function loadFever(file = repoPath("data", "raw", "fever_dev.jsonl")): EvalItem[] {
  const all = jsonl<{ id: number; claim: string; label: string }>(file).map((r) => {
    const gold = FEVER_LABELS[r.label];
    if (!gold) throw new Error(`unknown FEVER label ${r.label}`);
    return { id: `fever:${r.id}`, dataset: "fever" as const, claim: r.claim, gold };
  });
  return balancedSample(all, 200, SEED);
}

/** HoVer `label` is an integer class: 0 = NOT_SUPPORTED, 1 = SUPPORTED (dataset card). */
export async function loadHover(
  file = repoPath("data", "raw", "hover", "validation.parquet"),
): Promise<EvalItem[]> {
  const buf = readFileSync(file);
  const rows = (await parquetReadObjects({
    file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  })) as {
    uid: string;
    claim: string;
    label: bigint | number;
  }[];
  const all = rows.map((r) => {
    const label = Number(r.label);
    if (label !== 0 && label !== 1) throw new Error(`unexpected HoVer label ${r.label}`);
    return {
      id: `hover:${r.uid}`,
      dataset: "hover" as const,
      claim: r.claim,
      gold: (label === 1 ? "SUPPORTED" : "NOT_SUPPORTED") as BinaryLabel,
    };
  });
  return balancedSample(all, 150, SEED);
}

export async function loadDataset(name: DatasetName): Promise<EvalItem[]> {
  if (name === "scifact") return loadSciFact();
  if (name === "fever") return loadFever();
  return loadHover();
}

export async function loadSplit(name: DatasetName, split: Split): Promise<EvalItem[]> {
  const items = await loadDataset(name);
  return split === "all" ? items : splitItems(items)[split];
}

/** Maps a pipeline label to the dataset's label space (HoVer: REFUTED and NEI → NOT_SUPPORTED, §8). */
export function toDatasetLabel(dataset: DatasetName, label: Label): GoldLabel {
  if (dataset !== "hover") return label;
  return label === "SUPPORTED" ? "SUPPORTED" : "NOT_SUPPORTED";
}
