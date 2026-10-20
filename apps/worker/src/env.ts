// Bindings, secrets and the gateway RPC contract (Platform_Development.md §3.1), typed locally because the
// gateway lives in another repo.
import type { RunHubDO } from "./runhub";
import type { ArchiveDO } from "./archive";
import type { WorkflowParams } from "./workflow";

export type Provider = "workersai" | "groq";
export type Msg = { role: "system" | "user" | "assistant"; content: string };

export interface GatewayLlmRequest {
  project: "satya";
  task: string;
  messages: Msg[];
  jsonSchema?: object;
  reasoning?: "low" | "medium" | "high";
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  pin?: { provider: Provider };
  cacheKey?: string;
  budgetClass?: "demo" | "eval";
}

export interface GatewayRpc {
  llm(req: GatewayLlmRequest): Promise<{
    text: string;
    json?: unknown;
    provider: Provider;
    model: string;
    usage: { input: number; output: number };
    neurons?: number;
    latencyMs: number;
    cached: boolean;
  }>;
  embed(req: { project: "satya"; texts: string[]; kind: "query" | "doc" }): Promise<number[][]>;
  rerank(req: { project: "satya"; query: string; passages: string[] }): Promise<number[]>;
  hashIp(ip: string): Promise<string>;
  checkSession(req: { token: string; ipHash: string }): Promise<{ ok: boolean; sessionId?: string }>;
  consume(req: {
    project: "satya";
    kind: "run" | "mcp";
    ipHash: string;
    amount?: number;
  }): Promise<{ ok: boolean; remaining: number; resetAt: string }>;
  remaining(project: "satya"): Promise<{ neurons: number; groqTokens: number; live: boolean }>;
}

export interface SatyaEnv {
  GATEWAY: Fetcher;
  SATYA_WORKFLOW: Workflow<WorkflowParams>;
  RUNHUB: DurableObjectNamespace<RunHubDO>;
  ARCHIVE: DurableObjectNamespace<ArchiveDO>;
  SATYA_ADMIN_TOKEN: string;
  SATYA_OWNER_TOKEN?: string;
  TAVILY_API_KEY?: string;
}

export const gatewayOf = (env: SatyaEnv): GatewayRpc => env.GATEWAY as unknown as GatewayRpc;
export const archiveOf = (env: SatyaEnv) => env.ARCHIVE.get(env.ARCHIVE.idFromName("archive"));
export const hubOf = (env: SatyaEnv, runId: string) => env.RUNHUB.get(env.RUNHUB.idFromName(runId));
