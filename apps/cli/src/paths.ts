import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from this file until it finds the repo root (the folder holding `configs/default.json`). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "configs", "default.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate the Satya repo root (configs/default.json).");
    dir = parent;
  }
}

export const repoRoot = findRepoRoot();
export const repoPath = (...parts: string[]): string => resolve(repoRoot, ...parts);
