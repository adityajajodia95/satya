// `createTools(ctx)` implements the core `Tools` port: validates args, applies the cache, and converts
// every failure into a friendly error result (tools never throw).
import type { ToolDoc, ToolName, ToolResult, Tools } from "@satya/core";
import { arxivSearch } from "./arxiv";
import { TOOL_ARGS, type ToolArgs } from "./args";
import { DEFAULT_TOOL_CACHE_TTL_S, toolCacheKey } from "./cache";
import { type ToolContext, ToolFailure } from "./context";
import { fetchUrl } from "./fetch-url";
import { scholarSearch } from "./scholar";
import { webSearch } from "./tavily";
import { wikiPage, wikiSearch } from "./wikipedia";

type Impl<N extends ToolName> = (ctx: ToolContext, args: ToolArgs<N>) => Promise<ToolDoc[]>;

const max = (ctx: ToolContext, n: number | undefined) => n ?? ctx.config.maxResults;

const IMPLEMENTATIONS: { [N in ToolName]: Impl<N> } = {
  web_search: (ctx, a) => webSearch(ctx, a.query, max(ctx, a.maxResults)),
  wiki_search: (ctx, a) => wikiSearch(ctx, a.query, max(ctx, a.maxResults)),
  wiki_page: (ctx, a) => wikiPage(ctx, a.title),
  arxiv_search: (ctx, a) => arxivSearch(ctx, a.query, max(ctx, a.maxResults)),
  scholar_search: (ctx, a) => scholarSearch(ctx, a.query, max(ctx, a.maxResults)),
  fetch_url: (ctx, a) => fetchUrl(ctx, a.url),
};

export function createTools(ctx: ToolContext): Tools {
  async function call<N extends ToolName>(tool: N, rawArgs: object): Promise<ToolResult> {
    if (!ctx.config.enabled.includes(tool)) {
      return { ok: false, tool, error: { code: "unavailable", message: `${tool} is not enabled` } };
    }
    const parsed = TOOL_ARGS[tool].safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        tool,
        error: { code: "blocked", message: `invalid arguments: ${parsed.error.message}` },
      };
    }
    const args = parsed.data as ToolArgs<N>;
    const key = toolCacheKey(tool, args);
    try {
      const cached = await ctx.cache?.get(key);
      if (cached) return { ok: true, tool, docs: cached, cached: true };
      const docs = await IMPLEMENTATIONS[tool](ctx, args);
      await ctx.cache?.put(key, docs, ctx.cacheTtlS ?? DEFAULT_TOOL_CACHE_TTL_S);
      return { ok: true, tool, docs, cached: false };
    } catch (e) {
      const failure = e instanceof ToolFailure ? e : new ToolFailure("bad_response", (e as Error).message);
      return { ok: false, tool, error: { code: failure.code, message: failure.message } };
    }
  }
  return { call: (name, args) => call(name, args) };
}
