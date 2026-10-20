import { execFile } from "node:child_process";
import { promisify, styleText } from "node:util";
import type { LaptopConfig } from "../config";
import { readUserEnv } from "../env";
import {
  type CheckResult,
  type OllamaPsModel,
  REQUIRED_OLLAMA_ENV,
  checkFullyOnGpu,
  checkModelsPresent,
  checkNode,
  checkOllamaEnv,
  checkVram,
  optionalKey,
} from "./checks";
import { readGpuMemory, sampleDuring } from "./gpu";

const run = promisify(execFile);

const INTERNET_PROBES: Record<string, string> = {
  Wikipedia: "https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json",
  arXiv: "https://export.arxiv.org/api/query?search_query=all:test&max_results=1",
  "Semantic Scholar": "https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title",
  Tavily: "https://api.tavily.com/",
};

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Evicts the models so the baseline reading excludes them (`ollama stop` handles chat and embedding models). */
async function unload(models: string[]): Promise<void> {
  await Promise.allSettled(models.map((model) => run("ollama", ["stop", model])));
  await new Promise((r) => setTimeout(r, 1500));
}

/** Concurrent chats the sample run fires, matching OLLAMA_NUM_PARALLEL so every KV slot is in use. */
const PARALLEL_SAMPLES = 3;

/** A realistic sample: concurrent Qwen3 chats at the configured context size plus a bge-m3 batch. */
async function sampleRun(cfg: LaptopConfig): Promise<void> {
  const { baseUrl, model, numCtx } = cfg.llm;
  const chat = () =>
    getJson(
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          options: { num_ctx: numCtx, num_predict: 64 },
          messages: [{ role: "user", content: "In one sentence: when was the Eiffel Tower completed?" }],
        }),
      },
      180_000,
    );
  await Promise.all(Array.from({ length: PARALLEL_SAMPLES }, chat));
  await getJson(
    `${baseUrl}/api/embed`,
    {
      method: "POST",
      body: JSON.stringify({
        model: cfg.embed.model,
        input: Array.from({ length: 16 }, (_, i) => `Sample passage ${i} about the Eiffel Tower in Paris.`),
      }),
    },
    120_000,
  );
}

export async function runDoctor(cfg: LaptopConfig, opts: { skipVram: boolean }): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode(process.versions.node)];
  const required = [cfg.llm.model, cfg.embed.model];
  const baseUrl = cfg.llm.baseUrl;

  let ollamaUp = false;
  try {
    const { version } = await getJson<{ version: string }>(`${baseUrl}/api/version`);
    results.push({ name: "Ollama reachable", status: "pass", detail: `${baseUrl} (v${version})` });
    ollamaUp = true;
  } catch (e) {
    results.push({ name: "Ollama reachable", status: "fail", detail: `${baseUrl}: ${(e as Error).message}` });
  }

  if (ollamaUp) {
    const tags = await getJson<{ models: { name: string }[] }>(`${baseUrl}/api/tags`);
    results.push(
      checkModelsPresent(
        tags.models.map((m) => m.name),
        required,
      ),
    );
  }

  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(REQUIRED_OLLAMA_ENV)) env[key] = await readUserEnv(key);
  results.push(checkOllamaEnv(env));

  for (const [key, what] of [
    ["OLLAMA_MODELS", "Ollama model store"],
    ["HF_HOME", "Hugging Face cache"],
  ] as const) {
    const value = await readUserEnv(key);
    results.push(
      value
        ? { name: key, status: "pass", detail: `${what}: ${value}` }
        : { name: key, status: "warn", detail: `unset — ${what} defaults to C:` },
    );
  }

  if (opts.skipVram) {
    results.push({ name: "VRAM budget", status: "warn", detail: "skipped (--skip-vram)" });
  } else if (ollamaUp && results.every((r) => r.status !== "fail")) {
    try {
      await unload(required);
      const baseline = (await readGpuMemory()).usedMiB;
      const { samples } = await sampleDuring(() => sampleRun(cfg));
      results.push(checkVram(baseline, samples));
      const ps = await getJson<{ models: OllamaPsModel[] }>(`${baseUrl}/api/ps`);
      results.push(checkFullyOnGpu(ps.models, required));
    } catch (e) {
      results.push({ name: "VRAM budget", status: "fail", detail: (e as Error).message });
    }
  } else {
    results.push({ name: "VRAM budget", status: "fail", detail: "not run: fix the failures above first" });
  }

  const probes = await Promise.all(
    Object.entries(INTERNET_PROBES).map(async ([name, url]) => {
      try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
        // Any HTTP answer (even 4xx from an unauthenticated probe) proves the host is reachable.
        return `${name} ${res.status}`;
      } catch {
        return `${name} unreachable`;
      }
    }),
  );
  const unreachable = probes.filter((p) => p.endsWith("unreachable"));
  results.push({
    name: "Internet",
    status: unreachable.length === 0 ? "pass" : "warn",
    detail: `${probes.join(", ")}${unreachable.length ? " — offline SciFact evaluation still works" : ""}`,
  });

  results.push(
    optionalKey("TAVILY_API_KEY", Boolean(process.env.TAVILY_API_KEY), "live web search on the laptop"),
  );
  results.push(
    optionalKey("SATYA_ADMIN_TOKEN", Boolean(process.env.SATYA_ADMIN_TOKEN), "parity admin routes"),
  );
  return results;
}

const MARK: Record<CheckResult["status"], string> = {
  pass: styleText("green", "PASS"),
  warn: styleText("yellow", "WARN"),
  fail: styleText("red", "FAIL"),
};

export function printResults(results: CheckResult[]): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  console.log(
    failed === 0
      ? styleText("green", `\nAll required checks passed${warned ? ` (${warned} optional warning(s))` : ""}.`)
      : styleText("red", `\n${failed} check(s) failed.`),
  );
}
