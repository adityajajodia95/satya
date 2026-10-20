// configs/default.json contract (shared by both executors). Validated when loaded.
import { z } from "zod";
import { ToolName } from "./schemas";

export const SatyaConfig = z.object({
  retrieval: z.object({
    chunkWords: z.number().int().positive(),
    chunkOverlap: z.number().int().nonnegative(),
    bm25K: z.number().int().positive(),
    denseK: z.number().int().positive(),
    rrfK: z.number().positive(),
    rerankTop: z.number().int().positive(),
    finalK: z.number().int().positive(),
    evidenceChars: z.number().int().positive(),
    maxPassages: z.number().int().positive(),
  }),
  pipeline: z.object({
    queriesPerClaim: z.number().int().min(1).max(3),
    debateRounds: z.number().int().min(0),
    judgeSamples: z.number().int().positive(),
    abstainThreshold: z.number().min(0).max(1),
    maxClaims: z.number().int().positive(),
    parallelClaims: z.number().int().positive(),
  }),
  tools: z.object({
    enabled: z.array(ToolName),
    maxResults: z.number().int().positive(),
    fetchMaxBytes: z.number().int().positive(),
    fetchTextChars: z.number().int().positive(),
    userAgent: z.string(),
  }),
  llm: z.object({
    temperature: z.number(),
    judgeTemperature: z.number(),
    reasoning: z.object({
      default: z.enum(["low", "medium", "high"]),
      judge: z.enum(["low", "medium", "high"]),
    }),
  }),
});
export type SatyaConfig = z.infer<typeof SatyaConfig>;

/** Evidence sources a user can select (web UI / API `sources`). */
export const SourceChoice = z.enum(["wikipedia", "web", "papers"]);
export type SourceChoice = z.infer<typeof SourceChoice>;
export const ALL_SOURCES: readonly SourceChoice[] = ["wikipedia", "web", "papers"];
