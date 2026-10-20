// Satya's evidence tools as an MCP server (MCP TypeScript SDK v2). The same factory serves stdio on the
// laptop (`npx satya mcp`) and Streamable HTTP on Workers (`/api/satya/mcp`, M10).
import { McpServer } from "@modelcontextprotocol/server";
import { ToolDoc, type ToolName, type Tools } from "@satya/core";
import { TOOL_ARGS, TOOL_DESCRIPTIONS } from "@satya/tools";
import { z } from "zod";

export const SERVER_INFO = { name: "satya-evidence", version: "1.0.0" } as const;

/** Read-only tools exposed publicly; `web_search` only when the caller opts in (it spends Tavily credits). */
export const PUBLIC_TOOLS: readonly ToolName[] = [
  "wiki_search",
  "wiki_page",
  "arxiv_search",
  "scholar_search",
  "fetch_url",
];

const TITLES: Record<ToolName, string> = {
  web_search: "Web search",
  wiki_search: "Wikipedia search",
  wiki_page: "Wikipedia page",
  arxiv_search: "arXiv search",
  scholar_search: "Semantic Scholar search",
  fetch_url: "Fetch web page",
};

export const ToolOutput = z.object({ docs: z.array(ToolDoc), cached: z.boolean() });

export interface SatyaMcpOptions {
  exposeWebSearch: boolean;
  /** Called before every tool call (e.g. the per-IP quota on Workers); throw to refuse the call. */
  beforeCall?: (tool: ToolName) => Promise<void>;
}

/** Plain-text rendering for clients that only show `content`. */
export function formatDocs(docs: readonly ToolDoc[]): string {
  if (docs.length === 0) return "No results.";
  return docs
    .map(
      (d, i) =>
        `${i + 1}. ${d.title}${d.url ? ` — ${d.url}` : ""}${d.published ? ` (${d.published})` : ""}\n${d.text}`,
    )
    .join("\n\n");
}

export function createSatyaMcpServer(tools: Tools, opts: SatyaMcpOptions): McpServer {
  const server = new McpServer(SERVER_INFO);
  const names: ToolName[] = opts.exposeWebSearch ? ["web_search", ...PUBLIC_TOOLS] : [...PUBLIC_TOOLS];
  for (const name of names) {
    server.registerTool(
      name,
      {
        title: TITLES[name],
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_ARGS[name],
        outputSchema: ToolOutput,
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
      },
      async (args: object) => {
        try {
          await opts.beforeCall?.(name);
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
        }
        const result = await tools.call(name, args);
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `${result.error.code}: ${result.error.message}` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: formatDocs(result.docs) }],
          structuredContent: { docs: result.docs, cached: result.cached },
        };
      },
    );
  }
  return server;
}
