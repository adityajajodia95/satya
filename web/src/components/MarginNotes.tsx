// Margin notes aligned with their claim (§10.5): each note is placed at its claim's vertical offset and pushed
// down when notes would overlap. On narrow screens they stack under the text.
import type { Report } from "@satya/core";
import { useLayoutEffect, useRef, useState } from "react";
import { claimView } from "../lib/report";
import s from "./desk.module.css";
import { VerdictStamp } from "./ui";

interface Props {
  report: Report;
  spanTops: Record<string, number>;
  selected: string | null;
  onSelect: (claimId: string) => void;
}

const GAP = 8;

export function MarginNotes({ report, spanTops, selected, onSelect }: Props) {
  const claims = report.claims.filter((c) => c.checkworthy);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [tops, setTops] = useState<Record<string, number>>({});

  // Re-measured on every render and whenever a note's own size changes (e.g. the web font arriving re-wraps
  // a note from one line to two), so notes never overlap.
  useLayoutEffect(() => {
    const place = () => {
      let floor = 0;
      const next: Record<string, number> = {};
      for (const c of [...claims].sort((a, b) => (spanTops[a.id] ?? 0) - (spanTops[b.id] ?? 0))) {
        const top = Math.max(spanTops[c.id] ?? floor, floor);
        next[c.id] = top;
        floor = top + (refs.current[c.id]?.offsetHeight ?? 48) + GAP;
      }
      setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    place();
    const ro = new ResizeObserver(place);
    for (const el of Object.values(refs.current)) if (el) ro.observe(el);
    return () => ro.disconnect();
  });

  const height = Math.max(
    0,
    ...claims.map((c) => (tops[c.id] ?? 0) + (refs.current[c.id]?.offsetHeight ?? 48)),
  );
  return (
    <ol className={s.margin} style={{ minHeight: height }} aria-label="Verdicts">
      {claims.map((c) => {
        const v = report.verdicts[c.id];
        const view = claimView(v);
        return (
          <li key={c.id} className={s.noteItem} style={{ top: tops[c.id] ?? 0 }}>
            <button
              type="button"
              ref={(el) => void (refs.current[c.id] = el)}
              className={`${s.note} ${selected === c.id ? s.noteSelected : ""}`}
              onClick={() => onSelect(c.id)}
              aria-label={`Claim ${c.id}: ${c.text}`}
            >
              <span className={s.noteHead}>
                <span className="mono">{c.id}</span>
                <VerdictStamp view={view} abstained={v?.abstained} />
                {v && view !== "unchecked" && view !== "pending" ? (
                  <span className="mono">{v.confidence.toFixed(2)}</span>
                ) : null}
              </span>
              <span className={s.noteText}>{view === "unchecked" ? "Not checked (capacity)" : c.text}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
