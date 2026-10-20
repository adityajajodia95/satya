// Records real API responses and pages as unit-test fixtures for packages/tools (run once, re-run to refresh):
//   npx tsx scripts/record-tool-fixtures.ts
// Every file is logged with its source URL, date and SHA-256 in fixtures/MANIFEST.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../packages/tools/test/fixtures/", import.meta.url);
const cfg = JSON.parse(readFileSync(new URL("../configs/default.json", import.meta.url), "utf8")).tools;
const headers = { "User-Agent": cfg.userAgent };
type Entry = { url: string; recorded: string; sha256: string; bytes: number };
const manifestUrl = new URL("MANIFEST.json", root);
const manifest: Record<string, Entry> = existsSync(manifestUrl)
  ? JSON.parse(readFileSync(manifestUrl, "utf8"))
  : {};
// Pass --refresh to re-record everything; otherwise only missing fixtures are fetched (resumable).
const refresh = process.argv.includes("--refresh");

const RECORDINGS: Record<string, string> = {
  "wiki_search.json":
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srsearch=Eiffel+Tower+completed+1889&srlimit=5",
  "wiki_page.json":
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=Eiffel+tower",
  "wiki_page_missing.json":
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=Zzqxv+no+such+page+4821",
  "scholar.json":
    "https://api.semanticscholar.org/graph/v1/paper/search?query=scientific+claim+verification&limit=5&fields=title%2Cabstract%2Cyear%2Curl",
  // Five HTML pages under permissive licences (CC BY-SA, public domain, OGL), capped like the real tool.
  "pages/wikipedia-eiffel.html": "https://en.wikipedia.org/wiki/Eiffel_Tower",
  "pages/mdn-html.html": "https://developer.mozilla.org/en-US/docs/Web/HTML",
  "pages/cdc-flu.html": "https://www.cdc.gov/flu/about/index.html",
  "pages/nasa-moon.html": "https://science.nasa.gov/moon/facts/",
  "pages/govuk-passport.html": "https://www.gov.uk/apply-renew-passport",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(new URL("pages/", root), { recursive: true });

for (const [file, url] of Object.entries(RECORDINGS)) {
  if (!refresh && manifest[file] && existsSync(new URL(file, root))) continue;
  let res: Response | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { headers });
    if (res.status !== 429) break;
    console.log(`  ${file}: 429, waiting ${5 * (attempt + 1)} s`);
    await sleep(5000 * (attempt + 1));
  }
  if (!res?.ok) {
    console.error(`SKIPPED ${file}: ${res?.status} from ${url} — re-run later`);
    continue;
  }
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (file.startsWith("pages/")) bytes = bytes.subarray(0, cfg.fetchMaxBytes);
  writeFileSync(new URL(file, root), bytes);
  manifest[file] = {
    url,
    recorded: new Date().toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  console.log(`${file}  ${bytes.length} bytes`);
  writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
  await sleep(url.includes("arxiv") ? 3000 : 1100);
}

// arXiv's API (export.arxiv.org/api/query) throttles hard since Oct 2026, so its two fixtures are the real
// sample responses published in arXiv's API user manual: "A Typical Atom Response" and the error feed.
const MANUAL = "https://info.arxiv.org/help/api/user-manual.html";
if (refresh || !manifest["arxiv.xml"] || !manifest["arxiv_error.xml"]) {
  const html = await (await fetch(MANUAL, { headers })).text();
  const blocks = [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&"),
  );
  const typical = blocks.find((b) => b.includes("<feed") && b.includes("hep-ex/0307015"));
  const error = blocks.find((b) => b.includes("<feed") && b.includes("api/errors#"));
  if (!typical || !error) throw new Error("arXiv manual examples not found");
  const dedent = (b: string) => b.replace(/^ {4}/gm, "").trim() + "\n";
  const files = [
    ["arxiv.xml", dedent(typical)],
    ["arxiv_error.xml", error.trim() + "\n"],
  ] as const;
  for (const [file, body] of files) {
    const bytes = new TextEncoder().encode(body);
    writeFileSync(new URL(file, root), bytes);
    manifest[file] = {
      url: `${MANUAL} (published example response)`,
      recorded: new Date().toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    console.log(`${file}  ${bytes.length} bytes`);
  }
  writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
}
