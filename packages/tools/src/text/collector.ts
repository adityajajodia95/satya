// Shared HTML-to-text rules for both runtimes. Each adapter (htmlparser2 on Node, HTMLRewriter on
// Workers) reports only *explicit* tags and raw text; this collector applies the same implied-close
// rules and entity decoding, so both adapters produce identical text for the same page (§7 M2).
import { decodeHTML } from "entities";

/** Elements whose text is collected (§7 M2). */
export const COLLECTED_TAGS = ["title", "h1", "h2", "h3", "p", "li"] as const;
/** Elements whose content is never text. */
export const SKIPPED_TAGS = ["script", "style", "noscript", "template"] as const;
/** CSS selector covering every element an adapter must report. */
export const WATCHED_SELECTOR = [...COLLECTED_TAGS, ...SKIPPED_TAGS].join(", ");

const COLLECTED = new Set<string>(COLLECTED_TAGS);
const SKIPPED = new Set<string>(SKIPPED_TAGS);
const CLOSES_OPEN_P = new Set(["p", "h1", "h2", "h3"]);

export interface PageText {
  title: string;
  text: string;
}

interface OpenBlock {
  tag: string;
  raw: string;
}

export class TextCollector {
  private readonly stack: OpenBlock[] = [];
  private readonly blocks: { tag: string; raw: string }[] = [];
  private skipDepth = 0;

  open(tag: string): void {
    const name = tag.toLowerCase();
    if (SKIPPED.has(name)) {
      this.skipDepth++;
      return;
    }
    if (!COLLECTED.has(name)) return;
    const top = this.stack.at(-1);
    // HTML implied end tags that HTMLRewriter does not report: <p>/<h1-3> close an open <p>, <li> closes <li>.
    if (top && ((CLOSES_OPEN_P.has(name) && top.tag === "p") || (name === "li" && top.tag === "li"))) {
      this.pop();
    }
    this.flushTop();
    this.stack.push({ tag: name, raw: "" });
  }

  close(tag: string): void {
    const name = tag.toLowerCase();
    if (SKIPPED.has(name)) {
      this.skipDepth = Math.max(0, this.skipDepth - 1);
      return;
    }
    const index = this.stack.map((b) => b.tag).lastIndexOf(name);
    if (index >= 0) {
      while (this.stack.length > index) this.pop();
    } else if (name === "ul" || name === "ol") {
      while (this.stack.at(-1)?.tag === "li") this.pop();
    } else if (name === "body" || name === "html") {
      while (this.stack.length) this.pop();
    }
  }

  text(raw: string): void {
    const top = this.stack.at(-1);
    if (top && this.skipDepth === 0) top.raw += raw;
  }

  finish(maxChars: number): PageText {
    while (this.stack.length) this.pop();
    let title = "";
    const lines: string[] = [];
    for (const block of this.blocks) {
      const text = normalise(block.raw);
      if (!text) continue;
      if (block.tag === "title") title ||= text;
      else lines.push(text);
    }
    const text = lines.join("\n");
    return { title, text: text.length > maxChars ? text.slice(0, maxChars) : text };
  }

  private flushTop(): void {
    const top = this.stack.at(-1);
    if (top && top.raw) {
      this.blocks.push({ tag: top.tag, raw: top.raw });
      top.raw = "";
    }
  }

  private pop(): void {
    this.flushTop();
    this.stack.pop();
  }
}

/** Decodes entities and collapses whitespace (applied per block, after all chunks are joined). */
export function normalise(raw: string): string {
  return decodeHTML(raw).replace(/\s+/g, " ").trim();
}
