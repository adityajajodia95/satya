import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseNvidiaSmi } from "./checks";

const run = promisify(execFile);

export async function readGpuMemory(): Promise<{ usedMiB: number; totalMiB: number }> {
  const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv"]);
  return parseNvidiaSmi(stdout);
}

/** Samples GPU memory every `intervalMs` while `work` runs; returns every sample taken. */
export async function sampleDuring<T>(
  work: () => Promise<T>,
  intervalMs = 250,
): Promise<{ result: T; samples: number[] }> {
  const samples: number[] = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      samples.push((await readGpuMemory()).usedMiB);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  try {
    const result = await work();
    samples.push((await readGpuMemory()).usedMiB);
    return { result, samples };
  } finally {
    running = false;
    await sampler;
  }
}
