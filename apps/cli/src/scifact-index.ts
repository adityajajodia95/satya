// SciFact closed corpus (§7 M6): chunk + embed the 5,183 abstracts with bge-m3 into a flat Float32 file
// (data/index/scifact.f32, row-major, L2-normalised) plus data/index/scifact.meta.jsonl (one passage per
// line, same order). Search is exact cosine over all rows — no approximate index.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import {
  Bm25Index,
  type CorpusIndex,
  type Embedder,
  type Passage,
  type SatyaConfig,
  chunkDoc,
  normalize,
  retrievalText,
} from "@satya/core";
import { repoPath } from "./paths";

export const SCIFACT_CORPUS = repoPath("data", "raw", "data", "corpus.jsonl");
export const INDEX_DIR = repoPath("data", "index");
const VECTORS = (dir: string) => `${dir}/scifact.f32`;
const META = (dir: string) => `${dir}/scifact.meta.jsonl`;

interface CorpusDoc {
  doc_id: number;
  title: string;
  abstract: string[];
}

export interface CorpusPassage extends Passage {
  docId: number;
}

/** Abstract sentences → chunks; ids are sha1("scifact:<doc_id>#<chunk>"), url null (closed corpus). */
export function corpusPassages(jsonl: string, cfg: SatyaConfig["retrieval"]): CorpusPassage[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => {
      const doc = JSON.parse(line) as CorpusDoc;
      return chunkDoc(
        {
          source: "corpus",
          url: `scifact:${doc.doc_id}`,
          title: doc.title,
          text: doc.abstract.join(" "),
          published: null,
        },
        cfg,
      ).map((p) => ({ ...p, url: null, docId: doc.doc_id }));
    });
}

export async function buildScifactIndex(
  embedder: Embedder,
  cfg: SatyaConfig["retrieval"],
  opts: { corpus?: string; dir?: string; batch?: number; log?: (line: string) => void } = {},
): Promise<{ passages: number; dim: number; seconds: number }> {
  const dir = opts.dir ?? INDEX_DIR;
  const log = opts.log ?? console.log;
  const batch = opts.batch ?? 64;
  const started = Date.now();
  const passages = corpusPassages(readFileSync(opts.corpus ?? SCIFACT_CORPUS, "utf8"), cfg);
  log(`chunked ${passages.length} passages`);
  const rows: Float32Array[] = [];
  for (let i = 0; i < passages.length; i += batch) {
    const vectors = await embedder.embed(passages.slice(i, i + batch).map(retrievalText), "doc");
    rows.push(...vectors.map(normalize));
    if ((i / batch) % 20 === 0) log(`embedded ${Math.min(i + batch, passages.length)}/${passages.length}`);
  }
  const dim = rows[0]?.length ?? 0;
  const flat = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => flat.set(r, i * dim));
  mkdirSync(dir, { recursive: true });
  writeFileSync(VECTORS(dir), Buffer.from(flat.buffer));
  writeFileSync(META(dir), passages.map((p) => JSON.stringify(p)).join("\n") + "\n");
  return { passages: passages.length, dim, seconds: (Date.now() - started) / 1000 };
}

export function scifactIndexExists(dir = INDEX_DIR): boolean {
  return existsSync(VECTORS(dir)) && existsSync(META(dir));
}

export function loadScifactIndex(dir = INDEX_DIR): CorpusIndex & { passages: CorpusPassage[] } {
  const passages = readFileSync(META(dir), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CorpusPassage);
  const buf = readFileSync(VECTORS(dir));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const dim = flat.length / passages.length;
  if (!Number.isInteger(dim))
    throw new Error(`index mismatch: ${flat.length} floats for ${passages.length} passages`);
  const vectors = passages.map((_, i) => flat.subarray(i * dim, (i + 1) * dim));
  return { passages, vectors, bm25: new Bm25Index(passages.map(retrievalText)) };
}
