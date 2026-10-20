// Builds the laptop `Ports` (Ollama LLM + bge-m3, ONNX re-ranker, Node tools with SQLite cache) and the
// validated shared config.
import { readFileSync } from "node:fs";
import { type EventSink, type Ports, SatyaConfig, type Tools } from "@satya/core";
import { connectHttp, connectInProcess, lazyMcpTools } from "@satya/mcp";
import { HostRateLimiter, createTools } from "@satya/tools";
import { htmlToTextNode } from "@satya/tools/text/node";
import { loadLaptopConfig, readJsonConfig } from "./config";
import { repoPath } from "./paths";
import { OllamaEmbedder } from "./providers/ollama-embedder";
import { OllamaLLM } from "./providers/ollama-llm";
import { TransformersReranker } from "./providers/transformers-reranker";
import type { SatyaStore } from "./store/sqlite";

export const loadSharedConfig = (): SatyaConfig =>
  SatyaConfig.parse(JSON.parse(readFileSync(repoPath("configs", "default.json"), "utf8")));

const TAVILY_MONTHLY_GUARD = readJsonConfig<{ tavilyMonthlyGuard: number }>("cloud.json").tavilyMonthlyGuard;

/** Evidence tools with the SQLite cache, per-host politeness and (when a key is set) the Tavily guard. */
export function createLaptopTools(store: SatyaStore, config = loadSharedConfig()): Tools {
  const tavilyKey = process.env.TAVILY_API_KEY;
  return createTools({
    config: config.tools,
    htmlToText: htmlToTextNode,
    cache: store.toolCache(),
    limiter: new HostRateLimiter(),
    ...(tavilyKey
      ? { tavily: { apiKey: tavilyKey, guard: store.creditGuard("tavily", TAVILY_MONTHLY_GUARD) } }
      : {}),
  });
}

/**
 * The research agent's tools, reached through MCP: an MCP client talks to Satya's own MCP server in-process
 * (`tools/list`, `tools/call`), or to a remote server when `SATYA_MCP_URL` is set (e.g. the deployed
 * /api/satya/mcp). Results are identical to the direct path (packages/mcp/test/client.test.ts).
 */
export function createResearchTools(store: SatyaStore, config = loadSharedConfig()): Tools {
  const remote = process.env.SATYA_MCP_URL;
  return lazyMcpTools(() =>
    remote
      ? connectHttp(new URL(remote))
      : connectInProcess(createLaptopTools(store, config), { exposeWebSearch: true }),
  );
}

export function createLaptopPorts(store: SatyaStore, sink: EventSink, config = loadSharedConfig()): Ports {
  const laptop = loadLaptopConfig();
  return {
    llm: new OllamaLLM(laptop.llm),
    embedder: new OllamaEmbedder(laptop.llm.baseUrl, laptop.embed.model),
    reranker: new TransformersReranker(laptop.rerank.model, laptop.rerank.dtype),
    tools: createResearchTools(store, config),
    sink,
    clock: { now: () => Date.now() },
  };
}

export const laptopModelLabel = (): string => loadLaptopConfig().llm.model;
