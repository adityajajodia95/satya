import { ALL_SOURCES, SYSTEMS, SourceChoice, type SystemName } from "@satya/core";
import { Command, InvalidArgumentError } from "commander";
import { loadLaptopConfig } from "./config";
import { downloadAll } from "./data/download";
import { DATASETS, type DatasetName, type Split } from "./eval/datasets";
import { writeReport } from "./eval/report";
import { runEval } from "./eval/run-eval";
import { exportAll, importAll } from "./eval/transfer";
import { record } from "./record";
import { tune } from "./eval/tune";
import { printResults, runDoctor } from "./doctor/run";
import { loadDotEnv } from "./env";
import { createLaptopPorts, createLaptopTools, loadSharedConfig } from "./laptop-ports";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createSatyaMcpServer } from "@satya/mcp";
import { buildScifactIndex, loadScifactIndex, scifactIndexExists } from "./scifact-index";
import { SatyaStore } from "./store/sqlite";
import { ProgressSink, formatReport, verifyText } from "./verify";

loadDotEnv();

const program = new Command()
  .name("satya")
  .description("Satya laptop executor — multi-agent fact verification")
  .showHelpAfterError();

program
  .command("doctor")
  .description("Check Node, Ollama, models, Ollama env vars, the 6 GB VRAM budget, internet and .env keys")
  .option("--skip-vram", "skip the GPU sample run (fast)")
  .action(async (opts: { skipVram?: boolean }) => {
    const results = await runDoctor(loadLaptopConfig(), { skipVram: Boolean(opts.skipVram) });
    printResults(results);
    process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
  });

program
  .command("data")
  .description("Dataset commands")
  .command("download")
  .description(
    "Download SciFact, FEVER dev and HoVer validation (§2B); logs URL + SHA-256 to data/raw/SOURCES.json",
  )
  .action(async () => {
    await downloadAll();
  });

program
  .command("index")
  .description("Build retrieval indexes")
  .command("scifact")
  .description("Chunk + embed the SciFact corpus with bge-m3 → data/index/scifact.f32 + scifact.meta.jsonl")
  .action(async () => {
    const store = new SatyaStore();
    const ports = createLaptopPorts(store, new ProgressSink(true));
    const r = await buildScifactIndex(ports.embedder, loadSharedConfig().retrieval);
    console.log(`indexed ${r.passages} passages × ${r.dim} dims in ${r.seconds.toFixed(1)} s`);
    store.close();
  });

const parseSources = (value: string): SourceChoice[] => {
  const parts = value.split(",").map((s) => s.trim());
  const bad = parts.filter((p) => !SourceChoice.safeParse(p).success);
  if (bad.length)
    throw new InvalidArgumentError(`unknown source(s): ${bad.join(", ")} (use ${ALL_SOURCES.join(",")})`);
  return parts as SourceChoice[];
};

program
  .command("verify")
  .description("Check the facts in a text and print a verdict per claim")
  .argument("<text>", "text to check")
  .option("--json", "print the full report as JSON")
  .option("--corpus <name>", "closed-corpus mode (offline): scifact")
  .option(
    "--sources <list>",
    "evidence sources: wikipedia,web,papers (web needs TAVILY_API_KEY)",
    parseSources,
  )
  .action(async (text: string, opts: { json?: boolean; corpus?: string; sources?: SourceChoice[] }) => {
    if (opts.corpus && opts.corpus !== "scifact")
      throw new InvalidArgumentError("only --corpus scifact is supported");
    if (opts.corpus && !scifactIndexExists())
      throw new Error("SciFact index missing — run: npx satya index scifact");
    const sources =
      opts.sources ?? ALL_SOURCES.filter((s) => s !== "web" || Boolean(process.env.TAVILY_API_KEY));
    const store = new SatyaStore();
    try {
      const report = await verifyText(store, text, {
        sources,
        ...(opts.corpus ? { corpus: loadScifactIndex() } : {}),
        quiet: Boolean(opts.json),
      });
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report, process.stdout.isTTY));
    } finally {
      store.close();
    }
  });

program
  .command("mcp")
  .description(
    "Serve Satya's evidence tools over MCP stdio (Claude Desktop, VS Code); web_search only with a Tavily key",
  )
  .action(async () => {
    const store = new SatyaStore();
    const server = createSatyaMcpServer(createLaptopTools(store), {
      exposeWebSearch: Boolean(process.env.TAVILY_API_KEY),
    });
    await server.connect(new StdioServerTransport());
  });

const oneOf =
  <T extends string>(allowed: readonly T[], what: string) =>
  (value: string): T => {
    if (!allowed.includes(value as T))
      throw new InvalidArgumentError(`unknown ${what} "${value}" (use ${allowed.join(", ")})`);
    return value as T;
  };

program
  .command("eval")
  .description("Evaluate a system on a dataset split (resumable; results in SQLite + results/*.jsonl)")
  .requiredOption("--dataset <name>", `one of ${DATASETS.join(", ")}`, oneOf(DATASETS, "dataset"))
  .requiredOption("--system <name>", `one of ${SYSTEMS.join(", ")}`, oneOf(SYSTEMS, "system"))
  .option("--split <split>", "dev | test | all", oneOf(["dev", "test", "all"] as const, "split"), "test")
  .option("--limit <n>", "only the first n items", (v) => Number.parseInt(v, 10))
  .option("--sample <n>", "seeded stratified subset of n items (preliminary runs)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--resume", "continue a previous run (skip finished items)", false)
  .option("--concurrency <n>", "items in flight (default 2)", (v) => Number.parseInt(v, 10), 2)
  .action(
    async (opts: {
      dataset: DatasetName;
      system: SystemName;
      split: Split;
      limit?: number;
      sample?: number;
      resume: boolean;
      concurrency: number;
    }) => {
      const store = new SatyaStore();
      try {
        const { summary: s, files } = await runEval(store, opts);
        console.log(
          `${s.dataset}/${s.system}/${s.split}: n ${s.n} · acc ${(100 * s.accuracy).toFixed(1)} · macro-F1 ${(100 * s.macroF1).toFixed(1)} · ECE ${s.ece.toFixed(3)} · AURC ${s.aurc.toFixed(3)} · coverage@τ ${(100 * s.selective.coverage).toFixed(1)} · ${s.secondsPerClaim.mean.toFixed(1)} s/claim · errors ${s.errors}`,
        );
        for (const f of files) console.log(`  ${f}`);
      } finally {
        store.close();
      }
    },
  );

program
  .command("tune")
  .description(
    "Tune τ on the dev split (satya_full): best selective accuracy with coverage ≥ 0.7 → configs/default.json",
  )
  .option("--datasets <list>", "comma-separated", (v) => v.split(",").map(oneOf(DATASETS, "dataset")), [
    ...DATASETS,
  ])
  .action((opts: { datasets: DatasetName[] }) => {
    const store = new SatyaStore();
    try {
      console.log(JSON.stringify(tune(store, opts.datasets), null, 2));
    } finally {
      store.close();
    }
  });

program
  .command("export")
  .description("Export all evaluation results to JSONL files (to move them between machines)")
  .argument("<dir>", "output directory")
  .action((dir: string) => {
    const store = new SatyaStore();
    try {
      for (const file of exportAll(store, dir)) console.log(file);
    } finally {
      store.close();
    }
  });

program
  .command("import")
  .description("Merge evaluation results exported by `satya export` (identical configurations only)")
  .argument("<dir>", "directory with exported JSONL files")
  .action((dir: string) => {
    const store = new SatyaStore();
    try {
      console.log(JSON.stringify(importAll(store, dir)));
    } finally {
      store.close();
    }
  });

program
  .command("record")
  .description("Record gallery runs through the deployed API (admin token from .env); resumable")
  .option("--target <url>", "deployed site", "https://aj-demos.pages.dev")
  .option("--texts <file>", "gallery texts", "gallery/texts.json")
  .action(async (opts: { target: string; texts: string }) => {
    const token = process.env.SATYA_ADMIN_TOKEN;
    if (!token) throw new Error("SATYA_ADMIN_TOKEN missing from .env");
    const r = await record(opts.target.replace(/\/$/, ""), opts.texts, token);
    console.log(`recorded ${r.recorded.length}; remaining: ${r.remaining.join(", ") || "none"}`);
  });

program
  .command("report")
  .description("Write results/SUMMARY.md and results/benchmarks.json from the stored results")
  .action(async () => {
    const store = new SatyaStore();
    try {
      const { summaries, files } = await writeReport(store);
      console.log(`${summaries.length} result sets → ${files.join(", ")}`);
    } finally {
      store.close();
    }
  });

await program.parseAsync();
