// The evaluation results published by `npx satya report` (results/benchmarks.json, copied into the build).
// Shared by the Benchmarks and "How it's built" pages so no number is ever typed in by hand.
import { useQuery } from "@tanstack/react-query";

export interface BenchmarkRow {
  dataset: string;
  system: string;
  n: number;
  sample?: { n: number; of: number };
  accuracy: number;
  accuracyCI?: [number, number];
  macroF1: number;
  ece: number;
}

export const useBenchmarks = <T extends BenchmarkRow = BenchmarkRow>() =>
  useQuery({
    queryKey: ["benchmarks"],
    queryFn: async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}benchmarks.json`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as { generatedAt: string; laptop: T[]; deployed?: T[] };
    },
  });
