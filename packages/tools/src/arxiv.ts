import type { ToolDoc } from "@satya/core";
import { type ToolContext, ToolFailure } from "./context";
import { request } from "./http";
import { elements, firstText } from "./xml";

const API = "https://export.arxiv.org/api/query";

export function parseArxivFeed(xml: string): ToolDoc[] {
  if (!/<feed[\s>]/.test(xml)) throw new ToolFailure("bad_response", "arXiv did not return an Atom feed");
  return elements(xml, "entry").flatMap((entry) => {
    const title = firstText(entry, "title");
    const summary = firstText(entry, "summary");
    const id = firstText(entry, "id");
    // arXiv reports API errors as a feed with one entry whose id is under /api/errors.
    if (id?.includes("arxiv.org/api/errors"))
      throw new ToolFailure("bad_response", `arXiv error: ${summary}`);
    if (!title || !summary) return [];
    return [
      {
        source: "arxiv" as const,
        url: id ? id.replace(/^http:/, "https:") : null,
        title,
        text: summary,
        published: firstText(entry, "published"),
      },
    ];
  });
}

export async function arxivSearch(ctx: ToolContext, query: string, maxResults: number): Promise<ToolDoc[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
  });
  const res = await request(ctx, `${API}?${params}`);
  return parseArxivFeed(await res.text());
}
