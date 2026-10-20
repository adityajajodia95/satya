// localStorage that never throws (private mode, blocked storage) — used only for per-browser conveniences.
export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the preference just isn't remembered
  }
}

const RUNS_KEY = "satya.myRuns";

/** Ids of runs started in this browser (the Archive lists only these; C5). Newest first, at most 50. */
export const myRuns = (): string[] => {
  try {
    const ids = JSON.parse(readStore(RUNS_KEY) ?? "[]") as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
export const rememberRun = (id: string) =>
  writeStore(RUNS_KEY, JSON.stringify([id, ...myRuns().filter((x) => x !== id)].slice(0, 50)));
export const forgetRun = (id: string) =>
  writeStore(RUNS_KEY, JSON.stringify(myRuns().filter((x) => x !== id)));
