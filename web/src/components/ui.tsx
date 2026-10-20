// Small shared pieces: VerdictStamp, ConfidenceBar, CitationChip, EmptyState, ErrorBanner, DataTable, ChartFrame.
// Verdicts never rely on colour alone: every stamp carries its label in words.
import type { ReactNode } from "react";
import { type ClaimView, VIEW_LABEL } from "../lib/report";
import s from "./ui.module.css";

export function VerdictStamp({ view, abstained }: { view: ClaimView; abstained?: boolean }) {
  return (
    <span className={`${s.stamp} ${s[view]}`}>
      {VIEW_LABEL[view]}
      {abstained && view === "nei" ? <span className={s.stampNote}> (abstained)</span> : null}
    </span>
  );
}

export function ConfidenceBar({ value, view }: { value: number; view: ClaimView }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={s.confidence}>
      <div
        className={s.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Confidence"
      >
        <div className={`${s.fill} ${s[`fill_${view}`]}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono">{value.toFixed(2)}</span>
    </div>
  );
}

export function CitationChip({ id, onClick }: { id: string; onClick?: (id: string) => void }) {
  return onClick ? (
    <button type="button" className={s.chip} onClick={() => onClick(id)} aria-label={`Show evidence ${id}`}>
      {id}
    </button>
  ) : (
    <span className={s.chip}>{id}</span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={s.empty}>{children}</p>;
}

export function ErrorBanner({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className={s.error} role="alert">
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  caption,
  onRowClick,
  rowKey,
}: {
  columns: Column<T>[];
  rows: T[];
  caption: string;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
}) {
  return (
    <div className={s.tableWrap} role="region" aria-label={caption} tabIndex={0}>
      <table className={s.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? s.num : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? s.clickable : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? s.num : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartFrame({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <figure className={s.chart}>
      <figcaption>
        <h2 className={s.frameTitle}>{title}</h2>
        {note && <p>{note}</p>}
      </figcaption>
      <div className={s.chartBody}>{children}</div>
    </figure>
  );
}
