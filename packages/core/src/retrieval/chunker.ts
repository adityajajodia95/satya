import type { Passage, ToolDoc } from "../schemas";
import { sha1Hex } from "../util/sha1";

export interface ChunkOptions {
  chunkWords: number;
  chunkOverlap: number;
}

/**
 * Splits a document into ~`chunkWords`-word chunks overlapping by `chunkOverlap` words.
 * Passage id = sha1(url + chunk index) (title when there is no url), so ids are stable across runs
 * and executors. The title prefix is applied at retrieval time (see `retrievalText`), keeping the
 * evidence shown to the debaters free of duplicated titles.
 */
export function chunkDoc(doc: ToolDoc, { chunkWords, chunkOverlap }: ChunkOptions): Passage[] {
  const words = doc.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const step = Math.max(1, chunkWords - chunkOverlap);
  const passages: Passage[] = [];
  for (let start = 0, index = 0; ; start += step, index++) {
    passages.push({
      id: sha1Hex(`${doc.url ?? doc.title}#${index}`),
      source: doc.source,
      url: doc.url,
      title: doc.title,
      text: words.slice(start, start + chunkWords).join(" "),
      published: doc.published,
    });
    if (start + chunkWords >= words.length) break;
  }
  return passages;
}

/** Text used for BM25, embeddings and re-ranking: the title prefix gives every chunk its context. */
export const retrievalText = (p: Passage): string => (p.title ? `${p.title}\n${p.text}` : p.text);

/** Removes duplicate passages (same id) keeping the first occurrence. */
export function dedupePassages(passages: readonly Passage[]): Passage[] {
  const seen = new Set<string>();
  return passages.filter((p) => !seen.has(p.id) && (seen.add(p.id), true));
}
