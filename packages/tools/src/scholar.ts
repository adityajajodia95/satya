import type { ToolDoc } from "@satya/core";
import type { ToolContext } from "./context";
import { requestJson } from "./http";

const API = "https://api.semanticscholar.org/graph/v1/paper/search";

interface ScholarResponse {
  data?: {
    paperId: string;
    title: string | null;
    abstract: string | null;
    year: number | null;
    url: string | null;
  }[];
}

/** No API key: Semantic Scholar's shared pool is often rate-limited, so 429s back off and then degrade. */
export async function scholarSearch(ctx: ToolContext, query: string, maxResults: number): Promise<ToolDoc[]> {
  const params = new URLSearchParams({ query, limit: String(maxResults), fields: "title,abstract,year,url" });
  const data = await requestJson<ScholarResponse>(ctx, `${API}?${params}`);
  // Papers without an abstract carry no checkable content beyond the title, so they are skipped.
  return (data.data ?? []).flatMap((p) =>
    p.title && p.abstract
      ? [
          {
            source: "scholar" as const,
            url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
            title: p.title,
            text: p.abstract,
            published: p.year === null ? null : String(p.year),
          },
        ]
      : [],
  );
}
