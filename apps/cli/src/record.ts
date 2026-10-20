// `satya record`: records gallery runs through the DEPLOYED API (§7 M11) so they reflect the deployed model.
// Uses the admin bearer token (no Turnstile/per-IP limit; free budgets still apply). Already-recorded slugs
// are skipped, so re-running the next day continues where the free capacity stopped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Report } from "@satya/core";
import { repoPath } from "./paths";

interface GalleryText {
  slug: string;
  title: string;
  text: string;
}
interface GalleryIndex {
  project: "satya";
  runs: {
    id: string;
    title: string;
    date: string;
    model: string;
    provider: string;
    file: string;
    factuality: number | null;
    claims: number;
    slug: string;
  }[];
}

const GALLERY = repoPath("gallery");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function record(
  target: string,
  textsFile: string,
  token: string,
  log = console.log,
): Promise<{ recorded: string[]; remaining: string[] }> {
  const texts = JSON.parse(readFileSync(textsFile, "utf8")) as GalleryText[];
  const indexFile = `${GALLERY}/index.json`;
  const index: GalleryIndex = existsSync(indexFile)
    ? (JSON.parse(readFileSync(indexFile, "utf8")) as GalleryIndex)
    : { project: "satya", runs: [] };
  const done = new Set(index.runs.map((r) => r.slug));
  const recorded: string[] = [];
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  for (const t of texts) {
    if (done.has(t.slug)) continue;
    const res = await fetch(`${target}/api/satya/runs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: t.text }),
    });
    const body = (await res.json()) as { runId?: string; error?: { code: string; message: string } };
    if (!res.ok || !body.runId) {
      log(
        `${t.slug}: ${res.status} ${body.error?.code ?? ""} — stopping (${body.error?.message ?? "no run id"})`,
      );
      break;
    }
    log(`${t.slug}: run ${body.runId}`);
    let result: { status: string; report: Report } | null = null;
    for (let i = 0; i < 180; i++) {
      await sleep(5000);
      const r = (await (await fetch(`${target}/api/satya/runs/${body.runId}`, { headers: auth })).json()) as {
        status: string;
        report: Report;
      };
      if (r.status !== "running") {
        result = r;
        break;
      }
    }
    if (!result) {
      log(`${t.slug}: timed out waiting for the run`);
      break;
    }
    if (result.status !== "done") {
      log(`${t.slug}: run ended ${result.status} (capacity or error) — not saved; stopping`);
      break;
    }
    const file = `${t.slug}.json`;
    writeFileSync(`${GALLERY}/${file}`, JSON.stringify({ title: t.title, ...result.report }, null, 2) + "\n");
    index.runs.push({
      id: result.report.runId,
      slug: t.slug,
      title: t.title,
      date: result.report.createdAt,
      model: result.report.model,
      provider: result.report.provider,
      file,
      factuality: result.report.factuality,
      claims: Object.keys(result.report.verdicts).length,
    });
    writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");
    recorded.push(t.slug);
    const s = Object.values(result.report.verdicts)
      .map((v) => v.label[0])
      .join("");
    log(`${t.slug}: saved (${s}; factuality ${result.report.factuality ?? "n/a"})`);
  }
  const have = new Set(index.runs.map((r) => r.slug));
  return { recorded, remaining: texts.map((t) => t.slug).filter((s) => !have.has(s)) };
}
