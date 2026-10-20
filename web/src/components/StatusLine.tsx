// "Splitting claims ✓ · Finding evidence 7/12 · Debating · Judging" plus "step 14 of ~60" (§10.5, §10.7).
import type { LiveRun } from "../lib/useRun";
import s from "./desk.module.css";

const STAGES: { key: LiveRun["stage"]; label: string }[] = [
  { key: "claims", label: "Splitting claims" },
  { key: "evidence", label: "Finding evidence" },
  { key: "debate", label: "Debating" },
  { key: "judge", label: "Judging" },
];
const ORDER = ["claims", "evidence", "debate", "judge", "done"];

export function StatusLine({ run }: { run: LiveRun }) {
  const at = ORDER.indexOf(run.stage);
  const withEvidence = Object.keys(run.report.evidence).length;
  const claims = run.report.claims.filter((c) => c.checkworthy).length;
  return (
    <p className={`label ${s.statusLine}`} role="status" aria-live="polite">
      {STAGES.map((st, i) => {
        const done = at > i || run.stage === "done";
        const current = at === i && run.stage !== "done";
        const counter =
          st.key === "evidence" && claims && (current || done) ? ` ${withEvidence}/${claims}` : "";
        return (
          <span key={st.key} className={current ? s.stageNow : done ? s.stageDone : s.stageLater}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            {st.label}
            {counter}
            {done && <span aria-label=" done"> ✓</span>}
          </span>
        );
      })}
      {run.progress && run.stage !== "done" && (
        <span className={s.stepCount}>
          {" "}
          — step {run.progress.step} of ~{run.progress.of}
        </span>
      )}
    </p>
  );
}
