// Writes prompts/<name>.schema.json from the zod output contracts in packages/core/src/schemas.ts.
// Run after changing a contract: `npx tsx scripts/write-prompt-schemas.ts`. A unit test fails if they drift.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { PROMPT_OUTPUTS } from "../packages/core/src/schemas";

for (const [name, schema] of Object.entries(PROMPT_OUTPUTS)) {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  writeFileSync(
    new URL(`../prompts/${name}.schema.json`, import.meta.url),
    JSON.stringify(json, null, 2) + "\n",
  );
  console.log(`prompts/${name}.schema.json`);
}
