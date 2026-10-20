// Helpers over a (possibly partial) Report: per-claim display state, summary counts, query-term highlighting.
import type { Claim, Report, Verdict } from "@satya/core";

export type ClaimView = "supported" | "refuted" | "nei" | "pending" | "unchecked";

export function claimView(v: Verdict | undefined): ClaimView {
  if (!v) return "pending";
  if (v.rationale === "capacity") return "unchecked";
  return v.label === "SUPPORTED" ? "supported" : v.label === "REFUTED" ? "refuted" : "nei";
}

export const VIEW_LABEL: Record<ClaimView, string> = {
  supported: "Supported",
  refuted: "Refuted",
  nei: "Not enough info",
  pending: "Checking…",
  unchecked: "Not checked (capacity)",
};

export function summary(report: Report) {
  const claims = report.claims.filter((c) => c.checkworthy);
  const verdicts = claims.map((c) => report.verdicts[c.id]);
  const count = (view: ClaimView) => verdicts.filter((v) => claimView(v) === view).length;
  return {
    claims: claims.length,
    supported: count("supported"),
    refuted: count("refuted"),
    unverified: count("nei") + count("unchecked"),
    pending: count("pending"),
    factuality: report.factuality,
  };
}

/** "9 claims · 6 supported · 2 refuted · 1 unverified · factuality 75%". */
export function summaryLine(report: Report): string {
  const s = summary(report);
  const parts = [
    `${s.claims} ${s.claims === 1 ? "claim" : "claims"}`,
    `${s.supported} supported`,
    `${s.refuted} refuted`,
    `${s.unverified} unverified`,
  ];
  if (s.pending) parts.push(`${s.pending} in progress`);
  parts.push(s.factuality === null ? "factuality —" : `factuality ${Math.round(s.factuality * 100)}%`);
  return parts.join(" · ");
}

/** A plain-language headline: "3 claims need a closer look" (§10.2 copy rule). */
export function headline(report: Report): string {
  const s = summary(report);
  if (s.pending) return `Checking ${s.claims} ${s.claims === 1 ? "claim" : "claims"}…`;
  const look = s.refuted + s.unverified;
  if (s.claims === 0) return "No checkable claims found";
  if (look === 0) return s.claims === 1 ? "The claim checks out" : `All ${s.claims} claims check out`;
  return `${look} ${look === 1 ? "claim needs" : "claims need"} a closer look`;
}

const STOP = new Set(
  "a an and are as at be been by for from has have in is it its of on or that the this to was were which with not".split(
    " ",
  ),
);
export const queryTerms = (text: string): string[] => [
  ...new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) ?? [])
      .map((t) => t.replace(/[.'-]+$/, ""))
      .filter((t) => t.length > 2 && !STOP.has(t)),
  ),
];

/** Splits text into [plain, match, plain, …] segments for <mark> highlighting; whole words only ("use" ≠ "houses"). */
export function highlightSegments(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (terms.length === 0) return [{ text, hit: false }];
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  const word = String.raw`[\p{L}\p{M}\p{N}]`; // letters, combining marks (Devanagari vowel signs), digits
  const re = new RegExp(`(?<!${word})(${escaped.join("|")})(?!${word})`, "giu");
  // split() with one capturing group alternates plain text (even indices) and matches (odd indices).
  return text
    .split(re)
    .map((part, i) => ({ text: part, hit: i % 2 === 1 }))
    .filter((seg) => seg.text !== "");
}

export interface TextSegment {
  text: string;
  claim?: Claim;
}

/** Splits the input text into plain runs and claim spans (overlaps resolved by start order). */
export function segmentText(input: string, claims: Claim[]): TextSegment[] {
  const spans = claims
    .filter((c) => c.span && c.checkworthy)
    .map((c) => ({ c, s: c.span![0], e: c.span![1] }))
    .sort((a, b) => a.s - b.s);
  const out: TextSegment[] = [];
  let pos = 0;
  for (const { c, s, e } of spans) {
    if (s < pos) continue; // overlapping quote: keep the first
    if (s > pos) out.push({ text: input.slice(pos, s) });
    out.push({ text: input.slice(s, e), claim: c });
    pos = e;
  }
  if (pos < input.length) out.push({ text: input.slice(pos) });
  return out;
}

export const domainOf = (url: string | null): string => {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
