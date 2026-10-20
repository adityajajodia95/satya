import type { ToolDoc } from "@satya/core";
import { type ToolContext, ToolFailure } from "./context";
import { requestJson } from "./http";

const API = "https://api.tavily.com/search";

interface TavilyResponse {
  results?: { title: string; url: string; content: string; published_date?: string | null }[];
}

export async function webSearch(ctx: ToolContext, query: string, maxResults: number): Promise<ToolDoc[]> {
  if (!ctx.tavily?.apiKey)
    throw new ToolFailure("unavailable", "web search is not configured (no Tavily key)");
  if (ctx.tavily.guard && !(await ctx.tavily.guard.tryConsume())) {
    throw new ToolFailure("quota", "monthly web-search credit guard reached");
  }
  const data = await requestJson<TavilyResponse>(ctx, API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.tavily.apiKey}` },
    body: JSON.stringify({ query, search_depth: "basic", include_answer: false, max_results: maxResults }),
  });
  return (data.results ?? []).map((r) => ({
    source: "web",
    url: r.url,
    title: r.title,
    text: r.content,
    published: r.published_date ?? null,
  }));
}
