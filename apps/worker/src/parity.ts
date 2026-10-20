// Nightly deployment-parity evaluation (§7 M10–M11): queued items run one at a time through the same
// Workflow with budget class "eval" — the gateway allows that only inside 18:30–23:50 UTC and only from
// capacity left unused that day. Each finished item starts the next while the window is open.
import { initialState, variantFor } from "@satya/core";
import type { ParityItem } from "./archive";
import { CONFIG, EST_GROQ_TOKENS_PER_CLAIM } from "./config";
import { type Provider, type SatyaEnv, archiveOf, gatewayOf, hubOf } from "./env";
import type { RunMeta } from "./runhub";

/** True inside the parity window (18:30–23:50 UTC = 00:00–05:20 IST). */
export function inParityWindow(now = Date.now()): boolean {
  const d = new Date(now);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minute >= 18 * 60 + 30 && minute < 23 * 60 + 50;
}

export async function startNextParity(env: SatyaEnv, now = Date.now()): Promise<string | null> {
  if (!inParityWindow(now)) return null;
  const remaining = await gatewayOf(env).remaining("satya");
  // Eval capacity is leftover capacity; the gateway enforces the real rule. Prefer Workers AI when any is left.
  const pin: Provider =
    remaining.groqTokens >= EST_GROQ_TOKENS_PER_CLAIM && remaining.neurons <= 0 ? "groq" : "workersai";
  const runId = `parity-${crypto.randomUUID()}`;
  const item: ParityItem | null = await archiveOf(env).parityNext(runId);
  if (!item) return null;
  const variant = variantFor("satya_full", CONFIG, {
    decompose: false,
    evidence: item.passages?.length ? "corpus" : "tools",
  });
  // FEVER/HoVer use Wikipedia tools only, exactly as the laptop evaluation (C7).
  const sources = item.dataset === "scifact" ? [] : (["wikipedia"] as const);
  const meta: RunMeta = {
    runId,
    createdAt: new Date(now).toISOString(),
    pin,
    budgetClass: "eval",
    parity: item,
  };
  await hubOf(env, runId).init(
    meta,
    initialState({ runId, text: item.claim, sources: [...sources], maxClaims: 1, variant }),
  );
  await env.SATYA_WORKFLOW.create({ id: runId, params: { runId } });
  return runId;
}
