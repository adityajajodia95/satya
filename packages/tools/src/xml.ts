// A tiny, tolerant XML reader for arXiv's Atom feed (no DOM in Workers; no dependency needed).
import { decodeXML } from "entities";

/** Inner XML of every `<tag ...>...</tag>` (namespace prefixes ignored), in document order. */
export function elements(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

/** Text of the first `<tag>` element, CDATA unwrapped, entities decoded and whitespace collapsed. */
export function firstText(xml: string, tag: string): string | null {
  const inner = elements(xml, tag)[0];
  if (inner === undefined) return null;
  const unwrapped = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "");
  return decodeXML(unwrapped).replace(/\s+/g, " ").trim();
}
