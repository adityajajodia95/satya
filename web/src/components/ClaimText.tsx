// The original text with each claim underlined by its verdict (§10.5): solid green = supported, wavy red =
// refuted, dotted amber = not enough info, grey dotted = pending / not checked. Claims are buttons.
import type { Report } from "@satya/core";
import { forwardRef } from "react";
import { VIEW_LABEL, claimView, segmentText } from "../lib/report";
import s from "./desk.module.css";

interface Props {
  report: Report;
  selected: string | null;
  onSelect: (claimId: string) => void;
  registerSpan: (claimId: string, el: HTMLElement | null) => void;
}

export const ClaimText = forwardRef<HTMLDivElement, Props>(function ClaimText(
  { report, selected, onSelect, registerSpan },
  ref,
) {
  const segments = segmentText(report.inputText, report.claims);
  return (
    <div ref={ref} className={s.article} lang="en">
      {segments.map((seg, i) => {
        if (!seg.claim) return <span key={i}>{seg.text}</span>;
        const claim = seg.claim;
        const view = claimView(report.verdicts[claim.id]);
        return (
          <span
            key={i}
            ref={(el) => registerSpan(claim.id, el)}
            role="button"
            tabIndex={0}
            className={`${s.claim} ${s[`u_${view}`]} ${selected === claim.id ? s.selected : ""}`}
            aria-label={`${claim.text} — ${VIEW_LABEL[view]}. Open details`}
            aria-pressed={selected === claim.id}
            onClick={() => onSelect(claim.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(claim.id);
              }
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );
});
