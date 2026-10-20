// Prompt loader/renderer (§7 M1). Templates come from prompts/*.md via the generated module, so the
// laptop and the Worker render byte-identical prompts.
import type { Msg } from "./ports";
import { PROMPT_SCHEMAS, PROMPT_TEMPLATES } from "./prompts.generated";
import type { Argument, Evidence, PromptName } from "./schemas";

export class PromptError extends Error {
  override name = "PromptError";
}

/** Upper bounds per placeholder (characters). Longer values are truncated with an ellipsis. */
export const PLACEHOLDER_LIMITS: Readonly<Record<string, number>> = {
  text: 20_000,
  claim: 1_000,
  evidence: 8_000,
  transcript: 4_000,
};

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const ELLIPSIS = "…";

export function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : value.slice(0, Math.max(0, max - ELLIPSIS.length)).trimEnd() + ELLIPSIS;
}

export function templateFor(name: PromptName): string {
  return PROMPT_TEMPLATES[name];
}

export function schemaFor(name: PromptName): object {
  return PROMPT_SCHEMAS[name];
}

/** Placeholders a template expects, in order of first appearance. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

/**
 * Renders `{placeholder}`s in one pass. Values are inserted literally: braces inside a value are never
 * interpreted as placeholders (so user text such as "{claim}" cannot inject template structure).
 * A missing or unexpected value is a programming error and throws.
 */
export function render(
  template: string,
  values: Readonly<Record<string, string>>,
  limits: Readonly<Record<string, number>> = PLACEHOLDER_LIMITS,
): string {
  const expected = placeholdersOf(template);
  const missing = expected.filter((k) => values[k] === undefined);
  if (missing.length) throw new PromptError(`missing value for {${missing.join("}, {")}}`);
  const unexpected = Object.keys(values).filter((k) => !expected.includes(k));
  if (unexpected.length) throw new PromptError(`unexpected value for {${unexpected.join("}, {")}}`);
  return template.replace(PLACEHOLDER, (_, key: string) => {
    const value = values[key] as string;
    const limit = limits[key];
    return limit === undefined ? value : truncate(value, limit);
  });
}

export function renderPrompt(name: PromptName, values: Readonly<Record<string, string>>): Msg[] {
  return [{ role: "user", content: render(templateFor(name), values) }];
}

/** `[E1] (source, title) text…` — each passage truncated to `evidenceChars` (§7 M1). */
export function renderEvidence(evidence: readonly Evidence[], evidenceChars: number): string {
  if (evidence.length === 0) return "(no evidence found)";
  return evidence
    .map(
      (e) => `[${e.id}] (${e.passage.source}, ${e.passage.title}) ${truncate(e.passage.text, evidenceChars)}`,
    )
    .join("\n");
}

/** Debate transcript, keeping only the last `keepPerSide` turns per side to bound tokens (§9). */
export function renderTranscript(args: readonly Argument[], keepPerSide = 2): string {
  if (args.length === 0) return "(none yet)";
  const keep = new Set<Argument>();
  for (const side of ["advocate", "skeptic"] as const) {
    args
      .filter((a) => a.side === side)
      .slice(-keepPerSide)
      .forEach((a) => keep.add(a));
  }
  return args
    .filter((a) => keep.has(a))
    .map((a) => `Round ${a.round} ${a.side.toUpperCase()}: ${a.text}`)
    .join("\n");
}
