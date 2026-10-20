import type { ToolErrorCode } from "@satya/core";
import type { ToolCache } from "./cache";
import type { HostRateLimiter } from "./rate";
import type { PageText } from "./text/collector";

/** The `tools` section of configs/default.json. */
export interface ToolsConfig {
  enabled: string[];
  maxResults: number;
  fetchMaxBytes: number;
  fetchTextChars: number;
  userAgent: string;
}

export type HtmlToText = (html: string, maxChars: number) => Promise<PageText>;

/** Guards a monthly credit budget (Tavily: 900 of the free 1,000 credits). */
export interface CreditGuard {
  tryConsume(): Promise<boolean>;
}

export interface ToolContext {
  config: ToolsConfig;
  htmlToText: HtmlToText;
  fetch?: typeof fetch;
  cache?: ToolCache;
  cacheTtlS?: number;
  limiter?: HostRateLimiter;
  tavily?: { apiKey: string; guard?: CreditGuard };
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Total time a single tool call may take, including retries (must stay below the 20 s step timeout). */
  callBudgetMs?: number;
  random?: () => number;
}

/** Thrown inside tool implementations; `call()` converts it into a friendly error result. */
export class ToolFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}
