// The Desk (§10.5, §10.7): opens on the latest recorded run; "Check facts" runs a live check (Turnstile
// session first); claims appear as they are decomposed and their underlines change as verdicts arrive.
import { ALL_SOURCES, type Report, type SourceChoice } from "@satya/core";
import {
  ApiError,
  CapacityNotice,
  type GalleryEntry,
  type PlatformStatus,
  RunBadge,
  WakingOverlay,
  demoState,
  useGallery,
  useSession,
} from "aj-demo-kit";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ClaimText } from "../components/ClaimText";
import { Drawer } from "../components/Drawer";
import { HowItWorks } from "../components/HowItWorks";
import { MarginNotes } from "../components/MarginNotes";
import { StatusLine } from "../components/StatusLine";
import s from "../components/desk.module.css";
import { EmptyState, ErrorBanner } from "../components/ui";
import { createRun } from "../lib/api";
import { headline, summaryLine } from "../lib/report";
import { rememberRun } from "../lib/storage";
import { useRun } from "../lib/useRun";

const MAX_CHARS = 2000;
const SOURCE_LABELS: Record<SourceChoice, string> = { wikipedia: "Wikipedia", web: "Web", papers: "Papers" };

type RecordedRun = Report & { title?: string };

export function Desk({ status }: { status: PlatformStatus | null }) {
  const { runId } = useParams();
  const [params] = useSearchParams();
  const requested = params.get("run"); // a recorded run picked on the Runs page
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const gallery = useGallery<RecordedRun>(import.meta.env.BASE_URL);
  const [recorded, setRecorded] = useState<{ entry: GalleryEntry; report: RecordedRun } | null>(null);
  const [text, setText] = useState("");
  const [sources, setSources] = useState<SourceChoice[]>(["wikipedia", "web"]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [capacityHit, setCapacityHit] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const seed = (location.state as { text?: string; provider?: string; cached?: boolean } | null) ?? null;
  const live = useRun(
    runId ?? null,
    seed?.text ? { text: seed.text, provider: seed.provider ?? "workersai" } : undefined,
  );
  const demo = demoState(status, "satya");
  const capacity = capacityHit || demo.state === "capacity";

  // Only the most recent request may show its run: a slow first load must not replace a run picked meanwhile.
  const wanted = useRef<string | null>(null);
  const showRecorded = useCallback(
    async (entry: GalleryEntry) => {
      wanted.current = entry.id;
      const report = await gallery.load(entry);
      if (wanted.current === entry.id) setRecorded({ entry, report });
    },
    [gallery],
  );

  // First load: the recorded run asked for (?run=slug), else the latest one (§10.7). The picker keeps the
  // gallery's curated order.
  useEffect(() => {
    if (runId || recorded || wanted.current || !gallery.index?.runs.length) return;
    const runs = gallery.index.runs;
    void showRecorded(
      runs.find((r) => r.slug === requested) ?? runs.reduce((a, b) => (b.date > a.date ? b : a)),
    );
  }, [runId, recorded, gallery.index, showRecorded, requested]);

  useEffect(() => setSelected(null), [runId, recorded?.entry.id]);

  const pickRecorded = async (id: string) => {
    const entry = gallery.index?.runs.find((r) => r.id === id);
    if (!entry) return;
    if (runId) navigate("/");
    await showRecorded(entry);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) {
      setFormError("Paste a sentence or a paragraph to check.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await session.ensureSession();
      const r = await createRun(value, sources.length ? sources : [...ALL_SOURCES]);
      rememberRun(r.runId);
      navigate(`/run/${r.runId}`, { state: { text: value, provider: r.provider, cached: r.cached } });
    } catch (err) {
      if (err instanceof ApiError && err.code === "capacity_exhausted") setCapacityHit(true);
      else setFormError(err instanceof ApiError ? err.message : "Verification failed — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const report: Report | null = runId ? (live?.report ?? null) : (recorded?.report ?? null);
  const running = Boolean(runId && live && live.status === "running" && live.stage !== "done");

  return (
    <div className={s.desk}>
      <div className={s.column}>
        <form className={s.form} onSubmit={submit} aria-labelledby="paste-label">
          <label id="paste-label" htmlFor="text" className="label">
            Paste text to check
          </label>
          <textarea
            id="text"
            className={s.textarea}
            value={text}
            maxLength={MAX_CHARS}
            rows={5}
            placeholder="For example: The Eiffel Tower was completed in 1889. It is in Berlin."
            onChange={(e) => setText(e.target.value)}
            aria-describedby="char-count"
          />
          <div className={s.formRow}>
            <fieldset className={s.sources}>
              <legend className="label">Sources</legend>
              {ALL_SOURCES.map((src) => (
                <label key={src} className={s.check}>
                  <input
                    type="checkbox"
                    checked={sources.includes(src)}
                    onChange={(e) =>
                      setSources((prev) =>
                        e.target.checked ? [...prev, src] : prev.filter((x) => x !== src),
                      )
                    }
                  />
                  {SOURCE_LABELS[src]}
                </label>
              ))}
            </fieldset>
            <span id="char-count" className={s.counter}>
              {text.length.toLocaleString("en-IN")} / {MAX_CHARS.toLocaleString("en-IN")} characters
            </span>
          </div>
          {capacity ? (
            <CapacityNotice resetsAt={status?.resetsAt}>
              Today's free capacity is used — explore recorded runs; live checks reset at 05:30 IST.
            </CapacityNotice>
          ) : (
            <div className={s.formRow}>
              <button type="submit" className={s.primary} disabled={submitting || sources.length === 0}>
                {submitting ? "Starting…" : "Check facts"}
              </button>
              {sources.length === 0 && <span className={s.hint}>Choose at least one source.</span>}
            </div>
          )}
          <p className={s.limitNote}>
            Live checks are limited to <strong>3 per visitor per day</strong>. Satya runs on free model tiers
            shared by every visitor, and each check makes dozens of model calls — the limit keeps the demo
            available to everyone. Recorded runs are unlimited.
          </p>
          {demo.state === "waking" && <WakingOverlay project="satya" etaS={demo.etaS ?? 90} />}
          {formError && <ErrorBanner>{formError}</ErrorBanner>}
        </form>

        {gallery.index && gallery.index.runs.length > 0 && (
          <div className={s.picker}>
            <label htmlFor="gallery" className="label">
              Recorded runs
            </label>
            <select
              id="gallery"
              value={runId ? "" : (recorded?.entry.id ?? "")}
              onChange={(e) => void pickRecorded(e.target.value)}
            >
              {runId && <option value="">— choose a recorded run —</option>}
              {gallery.index.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {report ? (
          <section className={s.result} aria-labelledby="result-title">
            <div className={s.resultHead}>
              {runId ? (
                <RunBadge
                  kind={seed?.cached ? "cached" : "live"}
                  model="gpt-oss-120b"
                  provider={report.provider}
                  date={report.createdAt}
                />
              ) : (
                <RunBadge
                  kind="recorded"
                  model={recorded!.entry.model}
                  provider={recorded!.entry.provider}
                  date={recorded!.entry.date}
                />
              )}
              {recorded && !runId && recorded.report.title && (
                <span className={s.runTitle}>{recorded.report.title}</span>
              )}
            </div>
            {live && runId && running && <StatusLine run={live} />}
            {live?.error && (
              <ErrorBanner>
                {live.status === "failed" ? `This check couldn't finish: ${live.error}` : live.error}
              </ErrorBanner>
            )}
            {(live?.capacityHit || report.partial) && (
              <CapacityNotice resetsAt={status?.resetsAt}>
                Today's free capacity ran out during this check — claims marked "not checked" were skipped;
                live checks reset at 05:30 IST.
              </CapacityNotice>
            )}
            <h2 id="result-title" className={s.headline}>
              {report.claims.length || !running ? headline(report) : "Splitting the text into claims…"}
            </h2>
            <Article report={report} selected={selected} onSelect={setSelected} />
            {report.claims.length > 0 && <p className={`label ${s.summary}`}>{summaryLine(report)}</p>}
          </section>
        ) : runId ? (
          <EmptyState>Loading this check…</EmptyState>
        ) : gallery.error ? (
          <EmptyState>
            Recorded runs couldn't be loaded. Paste a text above and press "Check facts" to run a live check.
          </EmptyState>
        ) : (
          <EmptyState>
            Paste a text above and press "Check facts" — each claim will be underlined with its verdict.
          </EmptyState>
        )}
      </div>
      <HowItWorks />
      {report && selected && report.claims.find((c) => c.id === selected) && (
        <Drawer
          report={report}
          claim={report.claims.find((c) => c.id === selected)!}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** Reading column (68ch) + margin notes aligned with their claims. */
function Article({
  report,
  selected,
  onSelect,
}: {
  report: Report;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const spans = useRef<Record<string, HTMLElement | null>>({});
  const [tops, setTops] = useState<Record<string, number>>({});
  const register = useCallback((id: string, el: HTMLElement | null) => void (spans.current[id] = el), []);

  useLayoutEffect(() => {
    const measure = () => {
      const base = container.current?.getBoundingClientRect().top ?? 0;
      const next: Record<string, number> = {};
      for (const [id, el] of Object.entries(spans.current))
        if (el) next[id] = el.getBoundingClientRect().top - base;
      setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (container.current) ro.observe(container.current);
    return () => ro.disconnect();
  });

  if (!report.inputText) return null;
  return (
    <div className={s.articleGrid}>
      <ClaimText
        ref={container}
        report={report}
        selected={selected}
        onSelect={onSelect}
        registerSpan={register}
      />
      {report.claims.some((c) => c.checkworthy) && (
        <MarginNotes report={report} spanTops={tops} selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}
