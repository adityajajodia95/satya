// Runtime ports (§6.3). `packages/core` talks to the outside world only through these interfaces; the
// laptop executor binds them to Ollama/transformers.js/Node tools and the cloud executor to aj-gateway.
import type { RunEvent, Span, ToolName, ToolResult } from "./schemas";

export type Role = "system" | "user" | "assistant";
export interface Msg {
  role: Role;
  content: string;
}
export type Reasoning = "low" | "medium" | "high";

export interface LlmRequest {
  task: string;
  messages: Msg[];
  jsonSchema?: object;
  temperature?: number;
  reasoning?: Reasoning;
  seed?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  json?: unknown;
  usage: { input: number; output: number };
  model: string;
  provider: string;
  neurons?: number;
}

export interface LLM {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

export interface Embedder {
  embed(texts: string[], kind: "query" | "doc"): Promise<Float32Array[]>;
}

export interface Reranker {
  /** Raw relevance scores (logits) for each passage, in input order. */
  score(query: string, passages: string[]): Promise<number[]>;
}

export interface Tools {
  call(name: ToolName, args: object): Promise<ToolResult>;
}

export interface EventSink {
  emit(e: Omit<RunEvent, "seq" | "ts">): Promise<void>;
  span(s: Span): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface Ports {
  llm: LLM;
  embedder: Embedder;
  reranker: Reranker;
  tools: Tools;
  sink: EventSink;
  clock: Clock;
}
