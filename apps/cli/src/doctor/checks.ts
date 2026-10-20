// Pure evaluation logic for `satya doctor` (no IO, so it is unit-tested directly).

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const MIN_NODE_MAJOR = 22;
/** §2A: the laptop must stay inside a 6 GB VRAM budget (GB as nvidia-smi reports it: GiB). */
export const VRAM_BUDGET_MIB = 6 * 1024;

/** Values from Satya_Development.md §2A, except OLLAMA_NUM_PARALLEL = 3 (PROGRESS D18: batching within 6 GB). */
export const REQUIRED_OLLAMA_ENV: Readonly<Record<string, string>> = {
  OLLAMA_GPU_OVERHEAD: "2147483648",
  OLLAMA_FLASH_ATTENTION: "1",
  OLLAMA_KV_CACHE_TYPE: "q8_0",
  OLLAMA_MAX_LOADED_MODELS: "2",
  OLLAMA_NUM_PARALLEL: "3",
};

export function checkNode(version: string): CheckResult {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "Node.js", status: "pass", detail: `v${version.replace(/^v/, "")}` }
    : { name: "Node.js", status: "fail", detail: `v${version} — need >= ${MIN_NODE_MAJOR} LTS` };
}

/** Ollama tags carry an implicit ":latest" when the model was pulled without a tag. */
export function normaliseModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

export function checkModelsPresent(installed: string[], required: string[]): CheckResult {
  const have = new Set(installed.map(normaliseModelName));
  const missing = required.filter((m) => !have.has(normaliseModelName(m)));
  return missing.length === 0
    ? { name: "Ollama models", status: "pass", detail: required.join(", ") }
    : {
        name: "Ollama models",
        status: "fail",
        detail: `missing: ${missing.join(", ")} — run: ollama pull <model>`,
      };
}

export function checkOllamaEnv(actual: Record<string, string | undefined>): CheckResult {
  const wrong = Object.entries(REQUIRED_OLLAMA_ENV)
    .filter(([key, want]) => actual[key] !== want)
    .map(([key, want]) => `${key}=${actual[key] ?? "<unset>"} (want ${want})`);
  return wrong.length === 0
    ? { name: "Ollama env vars", status: "pass", detail: "all 5 set (§2A; NUM_PARALLEL 3, D18)" }
    : { name: "Ollama env vars", status: "fail", detail: wrong.join("; ") };
}

export interface OllamaPsModel {
  name: string;
  size: number;
  size_vram: number;
}

/** `ollama ps` shows "100% GPU" exactly when the whole loaded size is resident in VRAM. */
export function checkFullyOnGpu(loaded: OllamaPsModel[], required: string[]): CheckResult {
  const problems: string[] = [];
  for (const model of required) {
    const entry = loaded.find((m) => normaliseModelName(m.name) === normaliseModelName(model));
    if (!entry) problems.push(`${model} not loaded`);
    else if (entry.size_vram < entry.size) {
      problems.push(`${model} ${Math.round((100 * entry.size_vram) / entry.size)}% GPU`);
    }
  }
  return problems.length === 0
    ? { name: "ollama ps", status: "pass", detail: required.map((m) => `${m} 100% GPU`).join(", ") }
    : { name: "ollama ps", status: "fail", detail: problems.join("; ") };
}

export function checkVram(baselineMiB: number, samplesMiB: number[]): CheckResult {
  if (samplesMiB.length === 0)
    return { name: "VRAM budget", status: "fail", detail: "no nvidia-smi samples" };
  const peak = Math.max(...samplesMiB);
  const delta = peak - baselineMiB;
  const detail = `peak ${fmtGiB(peak)} − baseline ${fmtGiB(baselineMiB)} = ${fmtGiB(delta)} (budget ${fmtGiB(VRAM_BUDGET_MIB)})`;
  return { name: "VRAM budget", status: delta <= VRAM_BUDGET_MIB ? "pass" : "fail", detail };
}

/** Parses `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` output (first GPU). */
export function parseNvidiaSmi(csv: string): { usedMiB: number; totalMiB: number } {
  const row = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+\s*MiB\s*,\s*\d+\s*MiB$/i.test(l));
  if (!row) throw new Error(`Unexpected nvidia-smi output: ${csv.trim().slice(0, 120)}`);
  const [used, total] = row.split(",").map((v) => Number.parseInt(v, 10));
  return { usedMiB: used ?? 0, totalMiB: total ?? 0 };
}

export function optionalKey(name: string, present: boolean, neededFor: string): CheckResult {
  return present
    ? { name: `.env ${name}`, status: "pass", detail: "set" }
    : { name: `.env ${name}`, status: "warn", detail: `not set — optional, only needed for ${neededFor}` };
}

const fmtGiB = (mib: number): string => `${(mib / 1024).toFixed(2)} GB`;
