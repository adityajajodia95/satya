// `satya data download` (§2B): SciFact, FEVER dev and HoVer validation from the verified sources.
// Every file's source URL and SHA-256 is logged to data/raw/SOURCES.json. Any failure stops the command
// (the spec says: if a source fails, stop and ask). Raw archives are deleted once extracted (disk rule).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { repoPath } from "../paths";

const run = promisify(execFile);

export const SOURCES = {
  scifact: "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz",
  fever: "https://fever.ai/download/fever/shared_task_dev.jsonl",
  hoverTree: "https://huggingface.co/api/datasets/vincentkoc/hover-parquet/tree/main?recursive=true",
  hoverFile: (path: string) => `https://huggingface.co/datasets/vincentkoc/hover-parquet/resolve/main/${path}`,
} as const;

export const RAW_DIR = repoPath("data", "raw");
const LOG = repoPath("data", "raw", "SOURCES.json");

interface SourceEntry {
  url: string;
  file: string;
  sha256: string;
  bytes: number;
  downloaded: string;
  note?: string;
}

function readLog(): Record<string, SourceEntry> {
  return existsSync(LOG) ? (JSON.parse(readFileSync(LOG, "utf8")) as Record<string, SourceEntry>) : {};
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline((await import("node:fs")).createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(url: string, dest: string): Promise<SourceEntry> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return {
    url,
    file: dest.slice(repoPath().length + 1).replace(/\\/g, "/"),
    sha256: await sha256File(dest),
    bytes: statSync(dest).size,
    downloaded: new Date().toISOString(),
  };
}

export async function downloadAll(log: (line: string) => void = console.log): Promise<Record<string, SourceEntry>> {
  const entries = readLog();
  const save = () => writeFileSync(LOG, JSON.stringify(entries, null, 2) + "\n");
  mkdirSync(RAW_DIR, { recursive: true });

  // SciFact: tarball → data/raw/data/{corpus,claims_train,claims_dev,claims_test}.jsonl; tarball removed after.
  if (!existsSync(repoPath("data", "raw", "data", "corpus.jsonl"))) {
    const tar = repoPath("data", "raw", "scifact.tar.gz");
    entries.scifact = { ...(await download(SOURCES.scifact, tar)), note: "extracted to data/raw/data/; archive deleted" };
    save();
    // Windows: use the built-in bsdtar; a GNU tar from Git Bash on PATH would parse "D:" as a remote host.
    const tarExe = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "tar";
    await run(tarExe, ["-xzf", tar, "-C", RAW_DIR]);
    rmSync(tar);
    log(`SciFact  ${entries.scifact.bytes} bytes  sha256 ${entries.scifact.sha256}`);
  } else log("SciFact  already present");

  const feverPath = repoPath("data", "raw", "fever_dev.jsonl");
  if (!existsSync(feverPath)) {
    entries.fever = await download(SOURCES.fever, feverPath);
    save();
    log(`FEVER    ${entries.fever.bytes} bytes  sha256 ${entries.fever.sha256}`);
  } else log("FEVER    already present");

  // HoVer: list the repo tree and fetch the validation Parquet file(s).
  const tree = (await (await fetch(SOURCES.hoverTree)).json()) as { type: string; path: string }[];
  const files = tree.filter((f) => f.type === "file" && f.path.endsWith(".parquet") && /valid/i.test(f.path));
  if (files.length === 0) throw new Error(`HoVer: no validation parquet in ${SOURCES.hoverTree}`);
  for (const f of files) {
    const dest = repoPath("data", "raw", "hover", f.path.split("/").at(-1) as string);
    if (existsSync(dest)) {
      log(`HoVer    ${f.path} already present`);
      continue;
    }
    entries[`hover:${f.path}`] = await download(SOURCES.hoverFile(f.path), dest);
    save();
    log(`HoVer    ${f.path}  ${entries[`hover:${f.path}`]!.bytes} bytes  sha256 ${entries[`hover:${f.path}`]!.sha256}`);
  }
  save();
  return entries;
}
