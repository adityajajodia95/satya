// Copies the recorded gallery and the benchmark results into public/ so they ship with the static build.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const pub = new URL("../public/", import.meta.url);
mkdirSync(new URL("gallery/", pub), { recursive: true });
cpSync(new URL("gallery/", root), new URL("gallery/", pub), {
  recursive: true,
  filter: (src) => !src.endsWith("texts.json"),
});
const bench = new URL("results/benchmarks.json", root);
if (existsSync(bench)) cpSync(bench, new URL("benchmarks.json", pub));
console.log("copied gallery/ and benchmarks.json into web/public");
