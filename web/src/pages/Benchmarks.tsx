// Benchmarks (§10.5, §10.7): dataset tabs; comparison table
// (best value in bold, not coloured); risk–coverage; reliability diagram; confusion matrix. All numbers come
// from results/benchmarks.json written by `npx satya report` — nothing here is typed in by hand.
import { useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import s from "./pages.module.css";
import { ChartFrame, EmptyState } from "../components/ui";
import { useBenchmarks } from "../lib/benchmarks";

interface Summary {
  dataset: string;
  system: string;
  n: number;
  /** The run covers a sample of the split — the same claims for every system of that dataset. */
  sample?: { n: number; of: number };
  accuracy: number;
  accuracyCI?: [number, number];
  macroF1: number;
  ece: number;
  aurc: number;
  selective: { tau: number; coverage: number; selectiveAccuracy: number };
  confusion: { labels: string[]; matrix: number[][] };
  reliability: { lower: number; upper: number; count: number; meanConfidence: number; accuracy: number }[];
  riskCoverage: { coverage: number; risk: number }[];
  secondsPerClaim: { mean: number; median: number };
}
interface Benchmarks {
  generatedAt: string;
  laptop: Summary[];
  /** Deployed-model (parity) results, when that run exists; not shown until then. */
  deployed?: Summary[];
}

const DATASETS = [
  { id: "scifact", label: "SciFact" },
  { id: "fever", label: "FEVER" },
  { id: "hover", label: "HoVer" },
];
const NAMES: Record<string, string> = {
  llm_only: "LLM-only",
  single_agent_rag: "Single-agent RAG",
  satya_no_debate: "Satya w/o debate",
  satya_full: "Satya",
  dense_only: "Satya, dense-only",
  no_rerank: "Satya, no re-ranker",
  rounds_1: "Satya, 1 round",
  rounds_3: "Satya, 3 rounds",
};
/** Muted palette from the spec: navy, ochre, slate, brick. */
const PALETTE = ["var(--accent)", "var(--unsure)", "var(--ink-2)", "var(--bad)"];
const pct = (x: number) => `${(100 * x).toFixed(1)}`;
const MAIN = ["llm_only", "single_agent_rag", "satya_no_debate", "satya_full"];
/** System id without the report's annotation, e.g. "satya_full (partial 80/776)" → "satya_full". */
const baseOf = (system: string) => system.split(" ")[0]!;

export function Benchmarks() {
  const data = useBenchmarks<Summary>();
  const [dataset, setDataset] = useState("scifact");

  const rows = (data.data?.laptop ?? []).filter((r) => r.dataset === dataset);
  const ordered = [...rows].sort(
    (a, b) => ((MAIN.indexOf(baseOf(a.system)) + 9) % 99) - ((MAIN.indexOf(baseOf(b.system)) + 9) % 99),
  );
  const best = (pick: (r: Summary) => number, lower = false) => {
    const values = ordered.map(pick);
    return values.length > 1 ? (lower ? Math.min(...values) : Math.max(...values)) : null;
  };
  const bestAcc = best((r) => r.accuracy);
  const bestF1 = best((r) => r.macroF1);
  const bestEce = best((r) => r.ece, true);
  const bestAurc = best((r) => r.aurc, true);
  const satya = ordered.find((r) => baseOf(r.system) === "satya_full") ?? ordered[ordered.length - 1];
  const mainCurves = ordered.filter((r) => MAIN.includes(baseOf(r.system))).slice(0, 4);

  return (
    <section className={s.page} aria-labelledby="bench-title">
      <h1 id="bench-title">Benchmarks</h1>
      <p className={s.lead}>
        Test-split results from the evaluation harness. Accuracy and macro-F1 use the final label (an
        abstention counts as "not enough info"); calibration and risk–coverage use the raw label and
        confidence. Within a dataset every system is scored on the same claims; small grey numbers under
        accuracy are 95 % bootstrap intervals.
      </p>
      <div className={s.controls}>
        <div role="tablist" aria-label="Dataset" className={s.tabs}>
          {DATASETS.map((d) => (
            <button
              key={d.id}
              role="tab"
              type="button"
              aria-selected={dataset === d.id}
              className={dataset === d.id ? s.tabOn : s.tab}
              onClick={() => setDataset(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className={s.modelNote}>Model: Qwen3-4B on a laptop GPU (6 GB)</p>
      </div>

      {data.isLoading ? (
        <EmptyState>Loading results…</EmptyState>
      ) : data.isError ? (
        <EmptyState>
          Results aren't published yet — they appear here when the evaluation runs finish.
        </EmptyState>
      ) : ordered.length === 0 ? (
        <EmptyState>No results for this dataset yet — the evaluation is still running.</EmptyState>
      ) : (
        <>
          <div className={s.tableWrap} role="region" aria-label="Comparison table" tabIndex={0}>
            <table className={s.bench}>
              <caption className="sr-only">Comparison on {dataset}</caption>
              <thead>
                <tr>
                  <th scope="col">System</th>
                  <th scope="col" className={s.num}>
                    n
                  </th>
                  <th scope="col" className={s.num}>
                    Accuracy
                  </th>
                  <th scope="col" className={s.num}>
                    Macro-F1
                  </th>
                  <th scope="col" className={s.num}>
                    ECE ↓
                  </th>
                  <th scope="col" className={s.num}>
                    AURC ↓
                  </th>
                  <th scope="col" className={s.num}>
                    Coverage@τ
                  </th>
                  <th scope="col" className={s.num}>
                    s/claim
                  </th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => (
                  <tr key={r.system}>
                    <th scope="row">
                      {NAMES[baseOf(r.system)] ?? r.system}
                      {r.sample ? (
                        <span className={s.partial}>
                          {" "}
                          (sample {r.sample.n} of {r.sample.of})
                        </span>
                      ) : null}
                    </th>
                    <td className={s.num}>{r.n}</td>
                    <td className={s.num}>
                      {r.accuracy === bestAcc ? <strong>{pct(r.accuracy)}</strong> : pct(r.accuracy)}
                      {r.accuracyCI ? (
                        <span className={s.ci} title="95 % bootstrap interval">
                          {pct(r.accuracyCI[0])}–{pct(r.accuracyCI[1])}
                        </span>
                      ) : null}
                    </td>
                    <td className={s.num}>
                      {r.macroF1 === bestF1 ? <strong>{pct(r.macroF1)}</strong> : pct(r.macroF1)}
                    </td>
                    <td className={s.num}>
                      {r.ece === bestEce ? <strong>{r.ece.toFixed(3)}</strong> : r.ece.toFixed(3)}
                    </td>
                    <td className={s.num}>
                      {r.aurc === bestAurc ? <strong>{r.aurc.toFixed(3)}</strong> : r.aurc.toFixed(3)}
                    </td>
                    <td className={s.num}>{pct(r.selective.coverage)}</td>
                    <td className={s.num}>{r.secondsPerClaim.mean.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.charts}>
            <ChartFrame
              title="Risk–coverage"
              note="Error rate among the answered claims as coverage grows (lower is better)."
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
                  <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
                  <XAxis
                    dataKey="coverage"
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                    stroke="var(--ink-2)"
                    label={{ value: "Coverage", position: "insideBottom", offset: -12, fill: "var(--ink-2)" }}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                    stroke="var(--ink-2)"
                    width={44}
                  />
                  <Tooltip
                    formatter={(v) => (typeof v === "number" ? `${(100 * v).toFixed(1)}%` : String(v))}
                    labelFormatter={(v) =>
                      typeof v === "number" ? `coverage ${(100 * v).toFixed(0)}%` : String(v ?? "")
                    }
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--rule)" }}
                  />
                  <Legend verticalAlign="top" height={28} />
                  {mainCurves.map((r, i) => (
                    <Line
                      key={r.system}
                      data={r.riskCoverage}
                      dataKey="risk"
                      name={NAMES[baseOf(r.system)] ?? r.system}
                      stroke={PALETTE[i]}
                      dot={false}
                      strokeWidth={1.75}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
            {satya && (
              <ChartFrame
                title={`Reliability — ${NAMES[baseOf(satya.system)] ?? satya.system}`}
                note="Accuracy per confidence bin; the diagonal is perfect calibration."
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={satya.reliability.filter((b) => b.count > 0)}
                    margin={{ top: 8, right: 16, bottom: 24, left: 0 }}
                  >
                    <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="meanConfidence"
                      type="number"
                      domain={[0, 1]}
                      tickFormatter={(v: number) => v.toFixed(1)}
                      stroke="var(--ink-2)"
                      label={{
                        value: "Confidence",
                        position: "insideBottom",
                        offset: -12,
                        fill: "var(--ink-2)",
                      }}
                    />
                    <YAxis
                      domain={[0, 1]}
                      tickFormatter={(v: number) => v.toFixed(1)}
                      stroke="var(--ink-2)"
                      width={36}
                    />
                    <ReferenceLine
                      segment={[
                        { x: 0, y: 0 },
                        { x: 1, y: 1 },
                      ]}
                      stroke="var(--muted)"
                      strokeDasharray="4 4"
                    />
                    <Tooltip
                      formatter={(v) => (typeof v === "number" ? v.toFixed(2) : String(v))}
                      contentStyle={{ background: "var(--surface)", border: "1px solid var(--rule)" }}
                    />
                    <Line
                      dataKey="accuracy"
                      name="Accuracy"
                      stroke="var(--accent)"
                      strokeWidth={1.75}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </div>
          {satya && <Confusion summary={satya} name={NAMES[baseOf(satya.system)] ?? satya.system} />}
          <p className={s.note}>
            Generated {new Date(data.data!.generatedAt).toLocaleString("en-GB")} from results/*.jsonl.
          </p>
        </>
      )}
    </section>
  );
}

function Confusion({ summary, name }: { summary: Summary; name: string }) {
  const max = Math.max(1, ...summary.confusion.matrix.flat());
  const short = (l: string) =>
    ({
      SUPPORTED: "Supported",
      REFUTED: "Refuted",
      NOT_ENOUGH_INFO: "Not enough info",
      NOT_SUPPORTED: "Not supported",
    })[l] ?? l;
  return (
    <figure className={s.confusion}>
      <figcaption>
        <h2 className={s.confusionTitle}>Confusion matrix — {name}</h2>
        <p>Rows: gold label · columns: predicted (shade = count).</p>
      </figcaption>
      <table>
        <thead>
          <tr>
            <td />
            {summary.confusion.labels.map((l) => (
              <th key={l} scope="col">
                {short(l)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.confusion.matrix.map((row, i) => (
            <tr key={i}>
              <th scope="row">{short(summary.confusion.labels[i]!)}</th>
              {row.map((v, j) => (
                <td
                  key={j}
                  style={{
                    // shading capped at 35 % so the ink-coloured count keeps AA contrast in both themes
                    background: `color-mix(in srgb, var(--accent) ${Math.round((v / max) * 35)}%, var(--surface))`,
                  }}
                >
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
