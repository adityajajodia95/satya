// Shared pipeline config (identical to the laptop) + the cloud demo limits (configs/cloud.json).
import { SatyaConfig } from "@satya/core";
import cloudJson from "../../../configs/cloud.json";
import defaultJson from "../../../configs/default.json";

export const CONFIG: SatyaConfig = SatyaConfig.parse(defaultJson);
export const CLOUD = cloudJson as {
  maxInputChars: number;
  maxClaims: number;
  perStepTimeoutS: { llm: number; tool: number };
  stepRetries: number;
  estNeuronsPerClaim: number;
  archiveDays: number;
  tavilyMonthlyGuard: number;
};

/** Groq tokens per claim (Architecture §5: ≈ 16K in + 2.5K out) — used to decide whether Groq can take a run. */
export const EST_GROQ_TOKENS_PER_CLAIM = 18_500;
export const MODEL_LABEL = "gpt-oss-120b";

/** Changes when anything that affects results changes, so cached reports are never stale. */
export const CONFIG_VERSION = "2026-10-14.1";
