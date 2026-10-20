// Satya API client: aj-demo-kit's apiFetch plus owner mode (a token pasted once in your own browser that
// skips Turnstile and the per-visitor limit; budgets still apply).
import type { Report, RunEvent, SourceChoice } from "@satya/core";
import { apiFetch } from "aj-demo-kit";
import { readStore, writeStore } from "./storage";

const OWNER_KEY = "satya.ownerToken";
export const ownerToken = (): string | null => readStore(OWNER_KEY);
export const setOwnerToken = (token: string | null) =>
  writeStore(OWNER_KEY, token && token.trim() ? token.trim() : null);

const headers = (): Record<string, string> => {
  const t = ownerToken();
  return t ? { "X-Satya-Owner": t } : {};
};

export const API = "/api/satya";

export type RunStatus = "running" | "done" | "partial" | "failed";

export const createRun = (text: string, sources: SourceChoice[]) =>
  apiFetch<{ runId: string; cached: boolean; provider?: string }>(
    `${API}/runs`,
    { method: "POST", headers: headers(), body: JSON.stringify({ text, sources }) },
    { retries: 0 },
  );

export const fetchEvents = (runId: string, after: number) =>
  apiFetch<{ events: RunEvent[] }>(
    `${API}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    { headers: headers() },
    { retries: 2, timeoutMs: 15_000 },
  );

export const fetchRun = (runId: string) =>
  apiFetch<{ status: RunStatus; report: Report }>(
    `${API}/runs/${encodeURIComponent(runId)}`,
    { headers: headers() },
    { retries: 2 },
  );

export interface RunPreview {
  id: string;
  created: number;
  preview: string;
  factuality: number | null;
  nClaims: number;
  status: RunStatus;
  model: string;
  provider: string;
}

export const fetchRuns = (ids: string[]) =>
  ids.length
    ? apiFetch<{ runs: RunPreview[] }>(`${API}/runs?ids=${ids.map(encodeURIComponent).join(",")}`, {
        headers: headers(),
      })
    : Promise.resolve({ runs: [] });

export const deleteRun = (id: string) =>
  apiFetch<{ deleted: string }>(
    `${API}/runs/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: headers() },
    { retries: 0 },
  );
