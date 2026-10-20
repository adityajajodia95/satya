// Writes packages/tools/test/fixtures/pages/<page>.expected.json from the Node adapter. The Workers
// adapter test (run inside workerd) must reproduce these files exactly.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { htmlToTextNode } from "../packages/tools/src/text/node";

const dir = new URL("../packages/tools/test/fixtures/pages/", import.meta.url);
const maxChars = JSON.parse(readFileSync(new URL("../configs/default.json", import.meta.url), "utf8")).tools
  .fetchTextChars;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
  const page = await htmlToTextNode(readFileSync(new URL(file, dir), "utf8"), maxChars);
  writeFileSync(
    new URL(file.replace(/\.html$/, ".expected.json"), dir),
    JSON.stringify(page, null, 2) + "\n",
  );
  console.log(`${file}: title=${JSON.stringify(page.title)} chars=${page.text.length}`);
}
