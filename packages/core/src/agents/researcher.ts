// Researcher (§6, C7): queries → tool calls → passages. Pure planning functions, so each tool call can be
// its own named, retried step (`search:c1:q2:wiki`, `fetch:c1:3`) in both executors.
import type { SatyaConfig, SourceChoice } from "../config";
import { Bm25Index, rankIndices } from "../retrieval/bm25";
import { chunkDoc, dedupePassages, retrievalText } from "../retrieval/chunker";
import type { Passage, ToolDoc, ToolName, ToolResult } from "../schemas";
import type { Plan } from "./planner";

export interface ToolCallPlan {
  step: string;
  tool: ToolName;
  args: { query: string } | { title: string } | { url: string };
}

/** Wikipedia pages fetched in full (top titles across queries) and web pages fetched per claim. */
export const WIKI_PAGES_PER_CLAIM = 3;
export const WEB_FETCHES_PER_CLAIM = 3;

const SEARCHES: { source: SourceChoice; suffix: string; tool: ToolName; scientificOnly: boolean }[] = [
  { source: "wikipedia", suffix: "wiki", tool: "wiki_search", scientificOnly: false },
  { source: "web", suffix: "web", tool: "web_search", scientificOnly: false },
  { source: "papers", suffix: "arxiv", tool: "arxiv_search", scientificOnly: true },
  { source: "papers", suffix: "scholar", tool: "scholar_search", scientificOnly: true },
];

/** One search per (query × selected source); paper search only for `scientific` claims (C7). */
export function planSearches(
  claimId: string,
  plan: Plan,
  sources: readonly SourceChoice[],
  enabled: readonly ToolName[],
): ToolCallPlan[] {
  return plan.queries.flatMap((query, i) =>
    SEARCHES.filter(
      (s) => sources.includes(s.source) && enabled.includes(s.tool) && (!s.scientificOnly || plan.scientific),
    ).map((s) => ({ step: `search:${claimId}:q${i + 1}:${s.suffix}`, tool: s.tool, args: { query } })),
  );
}

/** Interleaves hit lists (1st of each, then 2nd of each, …) so every query contributes. */
function roundRobin<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length) out.push(l[i] as T);
  return out;
}

/** Host check by pattern (core has no `URL` global under its ES2023-only lib). */
const WIKIPEDIA_URL = /^https?:\/\/([a-z0-9-]+\.)*wikipedia\.org([/:?#]|$)/i;
const isWikipedia = (url: string | null) => !!url && WIKIPEDIA_URL.test(url);

/** Second stage: full Wikipedia pages for the top titles and the top web results (Wikipedia URLs skipped). */
export function planFetches(
  claimId: string,
  searches: readonly ToolResult[],
  enabled: readonly ToolName[],
): ToolCallPlan[] {
  const docsOf = (tool: ToolName) =>
    searches.filter((r) => r.ok && r.tool === tool).map((r) => (r.ok ? r.docs : []));
  const titles = [...new Set(roundRobin(docsOf("wiki_search")).map((d) => d.title))].slice(
    0,
    WIKI_PAGES_PER_CLAIM,
  );
  const urls = [
    ...new Set(
      roundRobin(docsOf("web_search"))
        .map((d) => d.url)
        .filter((u): u is string => !!u && !isWikipedia(u)),
    ),
  ].slice(0, WEB_FETCHES_PER_CLAIM);
  const calls: Omit<ToolCallPlan, "step">[] = [
    ...(enabled.includes("wiki_page")
      ? titles.map((title) => ({ tool: "wiki_page" as const, args: { title } }))
      : []),
    ...(enabled.includes("fetch_url")
      ? urls.map((url) => ({ tool: "fetch_url" as const, args: { url } }))
      : []),
  ];
  return calls.map((c, i) => ({ ...c, step: `fetch:${claimId}:${i + 1}` }));
}

/** Same URL from several tools (e.g. a search snippet and the full page): keep the longest text. */
export function dedupeDocsByUrl(docs: readonly ToolDoc[]): ToolDoc[] {
  const byKey = new Map<string, ToolDoc>();
  for (const doc of docs) {
    const key = doc.url ?? `title:${doc.title}`;
    const prev = byKey.get(key);
    if (!prev || doc.text.length > prev.text.length) byKey.set(key, doc);
  }
  return [...byKey.values()];
}

/**
 * All successful tool results → passages. Chunks are capped at `maxPassages` (cloud CPU budget, §7 M9)
 * by a BM25 pre-filter against the claim, so relevant chunks deep inside long pages survive the cap.
 */
export function collectPassages(claim: string, results: readonly ToolResult[], cfg: SatyaConfig): Passage[] {
  const docs = dedupeDocsByUrl(results.flatMap((r) => (r.ok ? r.docs : [])));
  const passages = dedupePassages(docs.flatMap((d) => chunkDoc(d, cfg.retrieval)));
  const max = cfg.retrieval.maxPassages;
  if (passages.length <= max) return passages;
  const keep = rankIndices(new Bm25Index(passages.map(retrievalText)).scores(claim), max).sort(
    (a, b) => a - b,
  );
  return keep.map((i) => passages[i] as Passage);
}
