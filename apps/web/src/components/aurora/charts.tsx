import { useId } from 'react';

// useId() output contains characters (: « ») that break url(#id) references in some browsers.
function useSvgId() {
  return `g${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Smooth path through evenly spaced points (horizontal-tangent cubic segments). */
export function smoothPath(values: number[], width: number, height: number, pad = 4): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [i * step, pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  return pts.reduce((d, [x, y], i) => {
    if (i === 0) return `M${x} ${y}`;
    const [px, py] = pts[i - 1]!;
    const c = (x - px) / 3;
    return `${d} C${px + c} ${py} ${x - c} ${y} ${x} ${y}`;
  }, '');
}

/** Tiny trend line. `ghost` draws a dashed placeholder for empty states. */
export function Sparkline({
  values,
  width = 120,
  height = 36,
  ghost = false,
}: {
  values: number[];
  width?: number;
  height?: number;
  ghost?: boolean;
}) {
  const id = useSvgId();
  const d = smoothPath(values, width, height);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <defs>
        <linearGradient id={`${id}-s`} x1="0" x2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent-b)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-a)' }} />
        </linearGradient>
      </defs>
      <path
        d={d}
        fill="none"
        style={{ stroke: ghost ? 'var(--line-2)' : `url(#${id}-s)` }}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeDasharray={ghost ? '3 5' : undefined}
      />
    </svg>
  );
}

/** Progress ring (0–1) in the theme accents. */
export function Ring({ value, size = 76, label }: { value: number; size?: number; label: string }) {
  const id = useSvgId();
  const r = 48;
  const circ = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}-r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-b)' }} />
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
      {v > 0 && (
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={`url(#${id}-r)`}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${(circ * v).toFixed(1)} ${circ.toFixed(1)}`}
          transform="rotate(-90 60 60)"
        />
      )}
      <text x="60" y="67" textAnchor="middle" style={{ fill: 'var(--text)' }} fontFamily="IBM Plex Mono" fontSize="22" fontWeight="600">
        {Math.round(v * 100)}%
      </text>
    </svg>
  );
}
