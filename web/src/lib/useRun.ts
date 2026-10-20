// Live run state for the Desk: polls /runs/:id/events every 1.5 s (§5.2), folds events into a partial
// report so claims appear as soon as they are decomposed and underlines change as verdicts arrive.
import type { Argument, Claim, Evidence, Report, RunEvent, Verdict } from "@satya/core";
import { ApiError } from "aj-demo-kit";
import { useEffect, useRef, useState } from "react";
import { type RunStatus, fetchEvents, fetchRun } from "./api";

export interface LiveRun {
  runId: string;
  status: RunStatus;
  report: Report;
  progress: { step: number; of: number; last: string } | null;
  stage: "claims" | "evidence" | "debate" | "judge" | "done";
  capacityHit: boolean;
  error: string | null;
}

const POLL_MS = 1500;

function emptyReport(runId: string, inputText: string, provider: string): Report {
  return {
    runId,
    inputText,
    claims: [],
    evidence: {},
    debate: {},
    verdicts: {},
    factuality: null,
    trace: [],
    model: "gpt-oss-120b",
    provider,
    createdAt: new Date().toISOString(),
    executor: "cloud",
    partial: false,
  };
}

export function stageOf(last: string): LiveRun["stage"] {
  if (/^(decompose|plan)/.test(last)) return "claims";
  if (/^(search|fetch|embed|rerank)/.test(last)) return "evidence";
  if (/^argue/.test(last)) return "debate";
  if (/^(judge|verdict)/.test(last)) return "judge";
  return "done";
}

export function applyEvent(run: LiveRun, e: RunEvent): LiveRun {
  const r = run.report;
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "claims":
      return { ...run, report: { ...r, claims: d.claims as Claim[] } };
    case "evidence":
      return {
        ...run,
        report: { ...r, evidence: { ...r.evidence, [d.claimId as string]: d.evidence as Evidence[] } },
      };
    case "argument": {
      const a = e.data as Argument;
      return {
        ...run,
        report: { ...r, debate: { ...r.debate, [a.claimId]: [...(r.debate[a.claimId] ?? []), a] } },
      };
    }
    case "verdict": {
      const v = e.data as Verdict;
      return { ...run, report: { ...r, verdicts: { ...r.verdicts, [v.claimId]: v } } };
    }
    case "stage": {
      const p = e.data as { step: number; of: number; last: string };
      return { ...run, progress: p, stage: stageOf(p.last) };
    }
    case "capacity":
      return { ...run, capacityHit: true };
    case "run_failed":
      return { ...run, status: "failed", error: String(d.message ?? "The run failed") };
    case "run_completed":
      return { ...run, stage: "done" };
    default:
      return run;
  }
}

/** Follows a run: events while running, then the final report. `initial` shows the input text immediately. */
export function useRun(runId: string | null, initial?: { text: string; provider: string }): LiveRun | null {
  const [run, setRun] = useState<LiveRun | null>(null);
  const after = useRef(0);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    after.current = 0;
    setRun({
      runId,
      status: "running",
      report: emptyReport(runId, initial?.text ?? "", initial?.provider ?? "workersai"),
      progress: null,
      stage: "claims",
      capacityHit: false,
      error: null,
    });

    const finish = async () => {
      const final = await fetchRun(runId);
      if (!cancelled)
        setRun((prev) =>
          prev ? { ...prev, status: final.status, report: final.report, stage: "done" } : prev,
        );
    };
    const poll = async () => {
      try {
        const { events } = await fetchEvents(runId, after.current);
        if (cancelled) return;
        if (events.length) {
          after.current = events[events.length - 1]!.seq;
          setRun((prev) => (prev ? events.reduce(applyEvent, prev) : prev));
        }
        if (events.some((e) => e.type === "run_completed" || e.type === "run_failed")) {
          await finish();
          return;
        }
        if (after.current === 0) {
          // first poll for an already-finished or cached run: load the report directly
          const r = await fetchRun(runId).catch(() => null);
          if (!cancelled && r && r.status !== "running") {
            setRun((prev) => (prev ? { ...prev, status: r.status, report: r.report, stage: "done" } : prev));
            return;
          }
          if (!cancelled && r)
            setRun((prev) =>
              prev && !prev.report.inputText
                ? { ...prev, report: { ...prev.report, inputText: r.report.inputText } }
                : prev,
            );
        }
      } catch (e) {
        if (!cancelled)
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  error: e instanceof ApiError ? e.message : "Lost contact with the server — retrying…",
                }
              : prev,
          );
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `initial` only seeds the first render of a run, so the effect depends on runId alone.
  }, [runId]);

  return run;
}
