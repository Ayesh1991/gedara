// Insights charts (hand-made, Aurora tokens; MASTER_PLAN §6). Every mark is a link one level
// deeper, and every chart shows its numbers as text too (the "table view"), so nothing is colour-
// or hover-only. One or two series at most: single series in the theme accent, two series as
// accent-b (in) / accent-a (out) with a legend, the same pairing Home uses. No animation.
import { Link, type LinkProps } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Target } from '@/lib/attention';
import { smoothPath } from '@/components/aurora/charts';
import { cn } from '@/lib/utils';

const asLink = (t: Target) => t as unknown as LinkProps;

// ── BarList: magnitude by category / shop / product (the workhorse) ──────────
export interface BarRow {
  key: string;
  label: string;
  sub?: string;
  value: number;
  to: Target;
  /** Text shown for the value (defaults to `format(value)`). */
  valueText?: string;
  /** Second, thinner bar (e.g. the budget behind the spending). */
  ghost?: number;
  tone?: 'default' | 'red' | 'caution';
}

export function BarList({
  rows,
  format,
  label,
  limit = 12,
}: {
  rows: BarRow[];
  format: (v: number) => string;
  label: string;
  limit?: number;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.value), r.ghost ?? 0)));
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={label} className="flex flex-col">
        {shown.map((r) => (
          <li key={r.key}>
            <Link
              {...asLink(r.to)}
              className="group flex flex-col gap-1.5 rounded-xl px-2 py-2.5 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-[var(--accent-b)]"
            >
              <span className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-[14.5px]">
                  {r.label}
                  {r.sub && <span className="ml-2 text-[12.5px] text-muted">{r.sub}</span>}
                </span>
                <span className="tabular shrink-0 text-[14px] font-medium">{r.valueText ?? format(r.value)}</span>
              </span>
              <span className="relative block h-2 rounded-full bg-white/[0.05]" aria-hidden>
                {r.ghost !== undefined && r.ghost > 0 && (
                  <span
                    className="absolute inset-y-0 left-0 rounded-full border border-white/25"
                    style={{ width: `${(r.ghost / max) * 100}%` }}
                  />
                )}
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full',
                    r.tone === 'red' ? 'bg-red' : r.tone === 'caution' ? 'bg-caution' : '',
                  )}
                  style={{
                    width: `${Math.max(1.5, (Math.abs(r.value) / max) * 100)}%`,
                    ...(r.tone && r.tone !== 'default'
                      ? {}
                      : { background: 'linear-gradient(90deg, var(--accent-a), var(--accent-b))' }),
                  }}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" onClick={() => setAll((a) => !a)} className="self-start px-2 py-1 text-[13px] text-accent-b">
          {all ? t('insights.showFewer') : t('insights.showAll', { count: rows.length })}
        </button>
      )}
    </div>
  );
}

// ── Columns: a value per month (one or two series) ────────────────────────────
export interface ColumnSeries {
  label: string;
  /** CSS colour (a theme token). */
  color: string;
}

export interface ColumnGroup {
  key: string;
  label: string;
  values: number[];
  to: Target;
}

export function Columns({
  groups,
  series,
  format,
  label,
  height = 160,
}: {
  groups: ColumnGroup[];
  series: ColumnSeries[];
  format: (v: number) => string;
  label: string;
  height?: number;
}) {
  const max = Math.max(1, ...groups.flatMap((g) => g.values.map(Math.abs)));
  return (
    <figure className="flex flex-col gap-3" aria-label={label}>
      {series.length > 1 && (
        <figcaption className="flex flex-wrap gap-4 text-[12.5px] text-[#a5b0d0]">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <div className="flex items-end gap-1 border-b border-line" style={{ height }}>
        {groups.map((g) => (
          <Link
            key={g.key}
            {...asLink(g.to)}
            title={`${g.label}: ${g.values.map((v, i) => `${series[i]?.label ?? ''} ${format(v)}`).join(' · ')}`}
            className="group flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] rounded-t-md px-[1px] hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-[var(--accent-b)]"
          >
            {g.values.map((v, i) => (
              <span
                key={i}
                className="w-full max-w-[22px] rounded-t-[4px] opacity-90 group-hover:opacity-100"
                style={{ height: `${(Math.abs(v) / max) * 100}%`, minHeight: v !== 0 ? 2 : 0, background: series[i]?.color }}
              />
            ))}
          </Link>
        ))}
      </div>
      <div className="tabular flex gap-1 text-[11px] text-faint" aria-hidden>
        {groups.map((g) => (
          <span key={g.key} className="min-w-0 flex-1 truncate text-center">
            {g.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

// ── Line: one series over time, each point a link ─────────────────────────────
export interface LinePoint {
  key: string;
  label: string;
  value: number;
  to: Target;
}

export function LineChart({
  points,
  format,
  label,
  height = 150,
  baseline,
}: {
  points: LinePoint[];
  format: (v: number) => string;
  label: string;
  height?: number;
  /** A reference value drawn as a dashed line (e.g. index 100). */
  baseline?: number;
}) {
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, baseline ?? Infinity);
  const hi = Math.max(...values, baseline ?? -Infinity);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  const range: [number, number] = [lo - pad, hi + pad];
  const W = 700;
  const y = (v: number) => (1 - (v - range[0]) / (range[1] - range[0])) * 100;
  const x = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * 100 : 50);
  return (
    <figure aria-label={label} className="flex flex-col gap-2">
      <div className="relative" style={{ height }}>
        <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden>
          {baseline !== undefined && (
            <line
              x1={0}
              x2={W}
              y1={(y(baseline) / 100) * height}
              y2={(y(baseline) / 100) * height}
              style={{ stroke: 'var(--line-2)' }}
              strokeDasharray="4 6"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.length > 1 && (
            <path
              d={smoothPath(values, W, height, 0, range)}
              fill="none"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              style={{ stroke: 'var(--accent-b)' }}
            />
          )}
        </svg>
        {points.map((p, i) => (
          <Link
            key={p.key}
            {...asLink(p.to)}
            title={`${p.label}: ${format(p.value)}`}
            aria-label={`${p.label}: ${format(p.value)}`}
            className="group absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-[var(--accent-b)]"
            style={{ left: `${x(i)}%`, top: `${y(p.value)}%` }}
          >
            <span className="h-2.5 w-2.5 rounded-full border-2 border-[var(--bg,#05070F)] bg-[var(--accent-b)] group-hover:scale-125" />
          </Link>
        ))}
      </div>
      <div className="tabular flex justify-between text-[11px] text-faint" aria-hidden>
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
    </figure>
  );
}

// ── Heatmap: weekday × hour ───────────────────────────────────────────────────
export function Heatmap({
  cells,
  rowLabels,
  format,
  label,
  cellTo,
}: {
  /** key 'weekday:hour' → value */
  cells: Map<string, number>;
  rowLabels: string[];
  format: (v: number) => string;
  label: string;
  cellTo: (weekday: number, hour: number) => Target;
}) {
  const max = Math.max(1, ...cells.values());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <figure aria-label={label} className="overflow-x-auto">
      <div className="grid min-w-[560px] gap-[2px]" style={{ gridTemplateColumns: `2.5rem repeat(24, minmax(0, 1fr))` }}>
        {rowLabels.map((day, d) => (
          <Row key={day} label={day}>
            {hours.map((h) => {
              const v = cells.get(`${d + 1}:${h}`) ?? 0;
              return v > 0 ? (
                <Link
                  key={h}
                  {...asLink(cellTo(d + 1, h))}
                  title={`${day} ${String(h).padStart(2, '0')}:00 · ${format(v)}`}
                  aria-label={`${day} ${String(h).padStart(2, '0')}:00 · ${format(v)}`}
                  className="aspect-square rounded-[3px] focus-visible:outline-2 focus-visible:outline-[var(--accent-b)]"
                  style={{ background: `color-mix(in srgb, var(--accent-b) ${Math.round(18 + (v / max) * 82)}%, transparent)` }}
                />
              ) : (
                <span key={h} className="aspect-square rounded-[3px] bg-white/[0.04]" aria-hidden />
              );
            })}
          </Row>
        ))}
        <span />
        {hours.map((h) => (
          <span key={h} className="tabular text-center text-[10px] text-faint" aria-hidden>
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
      </div>
    </figure>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="self-center text-[11px] text-muted">{label}</span>
      {children}
    </>
  );
}

/** A small headline figure with a label (e.g. savings rate), linking to its records. */
export function Figure({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[12.5px] text-[#a5b0d0]">{label}</span>
      <span className="tabular truncate text-[22px] leading-tight font-semibold tracking-tight">{children}</span>
      {hint && <span className="truncate text-[12px] text-muted">{hint}</span>}
    </div>
  );
}
