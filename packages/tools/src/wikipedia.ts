import type { ToolDoc } from "@satya/core";
import { decodeHTML } from "entities";
import { type ToolContext, ToolFailure } from "./context";
import { requestJson } from "./http";

const API = "https://en.wikipedia.org/w/api.php";

export const wikiUrl = (title: string): string =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

/** Search snippets are HTML (`<span class="searchmatch">`); reduce them to plain text. */
export const stripTags = (html: string): string =>
  decodeHTML(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

interface SearchResponse {
  query?: { search?: { title: string; snippet: string }[] };
}

export async function wikiSearch(ctx: ToolContext, query: string, maxResults: number): Promise<ToolDoc[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    format: "json",
    srsearch: query,
    srlimit: String(maxResults),
  });
  const data = await requestJson<SearchResponse>(ctx, `${API}?${params}`);
  return (data.query?.search ?? []).map((hit) => ({
    source: "wikipedia",
    url: wikiUrl(hit.title),
    title: hit.title,
    text: stripTags(hit.snippet),
    published: null,
  }));
}

interface ExtractResponse {
  query?: { pages?: Record<string, { title: string; extract?: string; missing?: string }> };
}

export async function wikiPage(ctx: ToolContext, title: string): Promise<ToolDoc[]> {
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    format: "json",
    titles: title,
  });
  const data = await requestJson<ExtractResponse>(ctx, `${API}?${params}`);
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || !page.extract) {
    throw new ToolFailure("not_found", `no Wikipedia page titled "${title}"`);
  }
  return [
    {
      source: "wikipedia",
      url: wikiUrl(page.title),
      title: page.title,
      text: page.extract.slice(0, ctx.config.fetchTextChars),
      published: null,
    },
  ];
}
