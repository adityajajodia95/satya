// Runs: the recorded runs (from the deployed system — every visitor sees these) and, below, the checks started
// in this browser (§10.5, C5: date, first 80 characters, claims, factuality, status; a row opens the run; delete
// asks for confirmation and only the creating session may delete).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type GalleryEntry, useGallery } from "aj-demo-kit";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import s from "./pages.module.css";
import { DataTable, EmptyState, ErrorBanner } from "../components/ui";
import { type RunPreview, deleteRun, fetchRuns } from "../lib/api";
import { forgetRun, myRuns } from "../lib/storage";

const fmt = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
const STATUS: Record<RunPreview["status"], string> = {
  running: "Running",
  done: "Done",
  partial: "Partial (capacity)",
  failed: "Failed",
};

const PROVIDER: Record<string, string> = { workersai: "Workers AI", groq: "Groq" };
const pctOf = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "—");

export function Archive() {
  const navigate = useNavigate();
  const gallery = useGallery(import.meta.env.BASE_URL);
  const client = useQueryClient();
  const [ids, setIds] = useState(myRuns);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["runs", ids], queryFn: () => fetchRuns(ids) });

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteRun(id);
    } catch (e) {
      // A run this browser can no longer delete on the server (e.g. session expired) is still removed from this list.
      if (!(e instanceof ApiError && e.status === 403)) {
        setError(e instanceof ApiError ? e.message : "Couldn't delete — please try again.");
        return;
      }
    }
    forgetRun(id);
    setIds(myRuns());
    setConfirming(null);
    await client.invalidateQueries({ queryKey: ["runs"] });
  };

  return (
    <section className={s.page} aria-labelledby="archive-title">
      <h1 id="archive-title">Runs</h1>
      <p className={s.lead}>
        Every check below ran end to end on the deployed system — the same pipeline a live check uses. Open
        one to see its claims, evidence, debate and verdicts.
      </p>

      <h2 className={s.h2}>Recorded runs</h2>
      {gallery.error ? (
        <ErrorBanner>The recorded runs couldn't be loaded.</ErrorBanner>
      ) : !gallery.index ? (
        <EmptyState>Loading the recorded runs…</EmptyState>
      ) : (
        <DataTable<GalleryEntry>
          caption="Recorded runs"
          rows={gallery.index.runs}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/?run=${String(r.slug)}`)}
          columns={[
            {
              key: "title",
              header: "Text",
              render: (r) => (
                <a
                  href={`${import.meta.env.BASE_URL}?run=${String(r.slug)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`/?run=${String(r.slug)}`);
                  }}
                >
                  {r.title}
                </a>
              ),
            },
            { key: "claims", header: "Claims", numeric: true, render: (r) => String(r.claims ?? "—") },
            { key: "fact", header: "Factuality", numeric: true, render: (r) => pctOf(r.factuality) },
            {
              key: "model",
              header: "Model",
              render: (r) => `${r.model} · ${PROVIDER[r.provider] ?? r.provider}`,
            },
            {
              key: "date",
              header: "Date",
              render: (r) => <span className="mono">{fmt(Date.parse(r.date))}</span>,
            },
          ]}
        />
      )}

      <h2 className={s.h2}>Your checks</h2>
      <p className={s.note}>
        Checks you start on the Desk are listed here, in this browser only, and kept for 30 days.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {runs.isError && (
        <ErrorBanner onRetry={() => void runs.refetch()}>The archive couldn't be loaded.</ErrorBanner>
      )}
      {ids.length === 0 ? (
        <EmptyState>
          None yet — paste a text on the Desk and press "Check facts" (or open a recorded run above).
        </EmptyState>
      ) : runs.isLoading ? (
        <EmptyState>Loading your checks…</EmptyState>
      ) : (runs.data?.runs.length ?? 0) === 0 ? (
        <EmptyState>
          Your earlier checks have expired (runs are kept for 30 days). Run a new check on the Desk.
        </EmptyState>
      ) : (
        <DataTable<RunPreview>
          caption="Your checks"
          rows={runs.data!.runs}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/run/${r.id}`)}
          columns={[
            { key: "date", header: "Date", render: (r) => <span className="mono">{fmt(r.created)}</span> },
            {
              key: "text",
              header: "Text",
              render: (r) => (
                <a
                  href={`${import.meta.env.BASE_URL}run/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`/run/${r.id}`);
                  }}
                >
                  {r.preview.slice(0, 80)}
                  {r.preview.length > 80 ? "…" : ""}
                </a>
              ),
            },
            { key: "claims", header: "Claims", numeric: true, render: (r) => r.nClaims },
            {
              key: "fact",
              header: "Factuality",
              numeric: true,
              render: (r) => (r.factuality === null ? "—" : `${Math.round(r.factuality * 100)}%`),
            },
            { key: "status", header: "Status", render: (r) => STATUS[r.status] },
            {
              key: "del",
              header: "",
              render: (r) =>
                confirming === r.id ? (
                  <span className={s.confirm} onClick={(e) => e.stopPropagation()}>
                    Delete this check?{" "}
                    <button type="button" onClick={() => void remove(r.id)}>
                      Delete
                    </button>{" "}
                    <button type="button" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={s.textButton}
                    aria-label={`Delete the check from ${fmt(r.created)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirming(r.id);
                    }}
                  >
                    Delete
                  </button>
                ),
            },
          ]}
        />
      )}
    </section>
  );
}
