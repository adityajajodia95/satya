// Tool argument contracts (shared by the pipeline and the MCP server's registerTool input schemas).
import type { ToolName } from "@satya/core";
import { z } from "zod";

const query = z.string().trim().min(1).max(300).describe("Search query");
const maxResults = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe("Maximum number of results (default 5)");

export const SearchArgs = z.object({ query, maxResults });
export const WikiPageArgs = z.object({
  title: z.string().trim().min(1).max(300).describe("Exact Wikipedia page title"),
});
export const FetchUrlArgs = z.object({
  url: z.string().trim().url().max(2000).describe("http(s) URL of an HTML page"),
});

export const TOOL_ARGS = {
  web_search: SearchArgs,
  wiki_search: SearchArgs,
  wiki_page: WikiPageArgs,
  arxiv_search: SearchArgs,
  scholar_search: SearchArgs,
  fetch_url: FetchUrlArgs,
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolArgs<N extends ToolName> = z.infer<(typeof TOOL_ARGS)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  web_search: "Search the web (Tavily). Returns titles, URLs and content snippets.",
  wiki_search: "Search English Wikipedia. Returns page titles, URLs and matching snippets.",
  wiki_page: "Get the plain-text content of an English Wikipedia page by exact title.",
  arxiv_search: "Search arXiv papers. Returns titles, abstracts, URLs and publication dates.",
  scholar_search: "Search Semantic Scholar papers. Returns titles, abstracts, years and URLs.",
  fetch_url:
    "Fetch a public web page and return its readable text (title, headings, paragraphs, list items).",
};
