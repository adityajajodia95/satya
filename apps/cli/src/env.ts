import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { repoPath } from "./paths";

const run = promisify(execFile);

/** Loads the gitignored laptop `.env` (if present) into `process.env`, without overriding real env vars. */
export function loadDotEnv(): void {
  const file = repoPath(".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * Reads a persisted user environment variable. `process.env` can be stale when the terminal was opened
 * before the variable was set, so on Windows we fall back to the user registry hive, which is what a
 * freshly started Ollama server sees.
 */
export async function readUserEnv(name: string): Promise<string | undefined> {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await run("reg", ["query", "HKCU\\Environment", "/v", name]);
    const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}
