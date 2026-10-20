// Claim drawer (§10.5): Verdict · Evidence · Debate · Trace tabs. Traps focus, closes with Esc, restores focus.
import type { Argument, Claim, Evidence, Report, Span, Verdict } from "@satya/core";
import { useEffect, useRef, useState } from "react";
import { claimView, domainOf, highlightSegments, queryTerms } from "../lib/report";
import s from "./drawer.module.css";
import { CitationChip, ConfidenceBar, EmptyState, VerdictStamp } from "./ui";

type Tab = "verdict" | "evidence" | "debate" | "trace";
const TABS: { id: Tab; label: string }[] = [
  { id: "verdict", label: "Verdict" },
  { id: "evidence", label: "Evidence" },
  { id: "debate", label: "Debate" },
  { id: "trace", label: "Trace" },
];
const SOURCE_TAG: Record<string, string> = {
  wikipedia: "WIKIPEDIA",
  web: "WEB",
  arxiv: "ARXIV",
  scholar: "SCHOLAR",
  corpus: "CORPUS",
};

export function Drawer({ report, claim, onClose }: { report: Report; claim: Claim; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("verdict");
  const [focusEvidence, setFocusEvidence] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const verdict = report.verdicts[claim.id];
  const evidence = report.evidence[claim.id] ?? [];
  const debate = report.debate[claim.id] ?? [];

  useEffect(() => {
    returnTo.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => (returnTo.current as HTMLElement | null)?.focus?.();
  }, []);

  useEffect(() => setTab("verdict"), [claim.id]);

  useEffect(() => {
    if (tab === "evidence" && focusEvidence) {
      const el = document.getElementById(`ev-${claim.id}-${focusEvidence}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus();
    }
  }, [tab, focusEvidence, claim.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const focusables = [
      ...panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const showEvidence = (id: string) => {
    setFocusEvidence(id);
    setTab("evidence");
  };

  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onKeyDown={onKeyDown}
      >
        <header className={s.head}>
          <p className="label">
            Claim <span className="mono">{claim.id}</span>
          </p>
          <button
            type="button"
            className={s.close}
            onClick={onClose}
            aria-label="Close claim details"
            data-autofocus
          >
            Close
          </button>
        </header>
        <h2 id="drawer-title" className={s.title}>
          {claim.text}
        </h2>
        <div className={s.tabs} role="tablist" aria-label="Claim details">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={`panel-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? s.tabOn : s.tab}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                setTab(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
            >
              {t.label}
              {t.id === "evidence" && evidence.length ? (
                <span className={s.count}> {evidence.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div
          className={s.body}
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          tabIndex={0}
        >
          {tab === "verdict" && <VerdictTab verdict={verdict} evidence={evidence} onCite={showEvidence} />}
          {tab === "evidence" && <EvidenceTab claim={claim} evidence={evidence} highlight={focusEvidence} />}
          {tab === "debate" && <DebateColumns args={debate} onCite={showEvidence} />}
          {tab === "trace" && <TraceTable spans={report.trace} claimId={claim.id} />}
        </div>
      </div>
    </div>
  );
}

function VerdictTab({
  verdict,
  evidence,
  onCite,
}: {
  verdict: Verdict | undefined;
  evidence: Evidence[];
  onCite: (id: string) => void;
}) {
  if (!verdict)
    return (
      <EmptyState>
        This claim is still being checked — the verdict appears here when the judges finish.
      </EmptyState>
    );
  const view = claimView(verdict);
  if (view === "unchecked")
    return (
      <EmptyState>
        Not checked: today's free capacity ran out during this run. Live checks reset at 05:30 IST.
      </EmptyState>
    );
  const cited = verdict.cited.filter((id) => evidence.some((e) => e.id === id));
  return (
    <div className={s.verdict}>
      <VerdictStamp view={view} abstained={verdict.abstained} />
      <div>
        <p className="label">Confidence</p>
        <ConfidenceBar value={verdict.confidence} view={view} />
      </div>
      {verdict.abstained && verdict.rawLabel !== verdict.label && (
        <p className={s.muted}>
          The judges leaned <strong>{verdict.rawLabel.toLowerCase().replace(/_/g, " ")}</strong>, but
          confidence was below the threshold, so Satya abstains.
        </p>
      )}
      <div>
        <p className="label">Judge's rationale</p>
        <p className={s.rationale}>{verdict.rationale || "—"}</p>
      </div>
      <div>
        <p className="label">Cited evidence</p>
        {cited.length ? (
          cited.map((id) => <CitationChip key={id} id={id} onClick={onCite} />)
        ) : (
          <p className={s.muted}>No evidence was cited.</p>
        )}
      </div>
      {verdict.samples.length > 0 && (
        <p className={s.muted}>
          Judge votes:{" "}
          <span className="mono">
            {verdict.samples.map((l) => l.replace("NOT_ENOUGH_INFO", "NEI")).join(" · ")}
          </span>
        </p>
      )}
    </div>
  );
}

function EvidenceTab({
  claim,
  evidence,
  highlight,
}: {
  claim: Claim;
  evidence: Evidence[];
  highlight: string | null;
}) {
  if (evidence.length === 0)
    return (
      <EmptyState>
        No evidence was found for this claim, so the judges could only say there isn't enough information.
      </EmptyState>
    );
  const terms = queryTerms(claim.text);
  return (
    <ol className={s.cards}>
      {evidence.map((e) => (
        <li key={e.id}>
          <article
            id={`ev-${claim.id}-${e.id}`}
            tabIndex={-1}
            className={`${s.card} ${highlight === e.id ? s.cardOn : ""}`}
          >
            <header className={s.cardHead}>
              <span className="mono">{e.id}</span>
              <span className={s.sourceTag}>
                {SOURCE_TAG[e.passage.source] ?? e.passage.source.toUpperCase()}
              </span>
              {e.passage.url && <span className={s.domain}>{domainOf(e.passage.url)}</span>}
              <span className={`mono ${s.score}`} title="Re-rank score (cross-encoder logit)">
                {e.rerank.toFixed(2)}
              </span>
            </header>
            <h3 className={s.cardTitle}>
              {e.passage.url ? (
                <a href={e.passage.url} target="_blank" rel="noreferrer">
                  {e.passage.title}
                </a>
              ) : (
                e.passage.title
              )}
            </h3>
            <p className={s.passage}>
              {highlightSegments(
                e.passage.text.length > 900 ? `${e.passage.text.slice(0, 900)}…` : e.passage.text,
                terms,
              ).map((seg, i) =>
                seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
              )}
            </p>
          </article>
        </li>
      ))}
    </ol>
  );
}

function renderArgument(text: string, onCite: (id: string) => void) {
  return text.split(/(\[?E\d+\]?)/g).map((part, i) => {
    const m = part.match(/^\[?(E\d+)\]?$/);
    return m ? <CitationChip key={i} id={m[1]!} onClick={onCite} /> : <span key={i}>{part}</span>;
  });
}

function DebateColumns({ args, onCite }: { args: Argument[]; onCite: (id: string) => void }) {
  if (args.length === 0)
    return (
      <EmptyState>
        The debate hasn't started yet — the advocate and the skeptic argue once the evidence is in.
      </EmptyState>
    );
  const rounds = [...new Set(args.map((a) => a.round))].sort((a, b) => a - b);
  return (
    <div className={s.debate}>
      <div className={s.debateHead} aria-hidden="true">
        <span className="label">Advocate</span>
        <span className="label">Skeptic</span>
      </div>
      {rounds.map((r) => (
        <section key={r} aria-label={`Round ${r}`}>
          <h3 className={`label ${s.round}`}>Round {r}</h3>
          <div className={s.debateRow}>
            {(["advocate", "skeptic"] as const).map((side) => {
              const a = args.find((x) => x.round === r && x.side === side);
              return (
                <div key={side} className={s.turn}>
                  {/* screen readers always; sighted readers on narrow screens, where the column heads are hidden */}
                  <span className={`label ${s.side}`}>{side === "advocate" ? "Advocate" : "Skeptic"}: </span>
                  {a ? renderArgument(a.text, onCite) : <span className={s.muted}>—</span>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function TraceTable({ spans, claimId }: { spans: Span[]; claimId: string }) {
  const rows = spans.filter(
    (sp) => sp.step.includes(`:${claimId}:`) || sp.step.endsWith(`:${claimId}`) || !/:c\d+/.test(sp.step),
  );
  if (rows.length === 0) return <EmptyState>No model calls recorded for this claim yet.</EmptyState>;
  return (
    <div className={s.traceWrap} role="region" aria-label="Model calls (scrolls sideways)" tabIndex={0}>
      <table className={s.trace}>
        <caption className="sr-only">Model calls for this claim</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Model</th>
            <th scope="col">Provider</th>
            <th scope="col" className={s.num}>
              Tokens in/out
            </th>
            <th scope="col" className={s.num}>
              ms
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((sp, i) => (
            <tr key={i} className={sp.ok ? undefined : s.traceFail}>
              <td className="mono">{sp.step}</td>
              <td>{sp.model.replace(/^@cf\/openai\//, "")}</td>
              <td>
                {sp.provider === "workersai" ? "Workers AI" : sp.provider === "groq" ? "Groq" : sp.provider}
              </td>
              <td className={`mono ${s.num}`}>
                {sp.inTok}/{sp.outTok}
              </td>
              <td className={`mono ${s.num}`}>{Math.round(sp.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
