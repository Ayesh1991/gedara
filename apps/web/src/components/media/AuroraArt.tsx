// The cover, floating on an aurora made of its own colours (Phase 7h). Three soft blobs drift
// behind the art (the same drift as the app's aurora, so Settings › Appearance › Motion and
// prefers-reduced-motion stop it too), the cover breathes very slightly while a song plays, and
// a song without a cover gets a generated one: its title's initial on a gradient seeded by the title.
import { Music2 } from 'lucide-react';
import { useState } from 'react';
import { coloursOf, css, type Rgb } from '@/lib/media/palette';
import { cn } from '@/lib/utils';

/** A stable gradient for a song without a cover. */
export function seededColours(seed: string): Rgb[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const hue = (h >>> 0) % 360;
  const hsl = (hh: number, s: number, l: number): Rgb => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hh / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  return [hsl(hue, 0.65, 0.42), hsl((hue + 48) % 360, 0.6, 0.38), hsl((hue + 300) % 360, 0.55, 0.34)];
}

export function Cover({
  url,
  title,
  className,
  rounded = 'rounded-2xl',
  onColours,
}: {
  url: string | null | undefined;
  title: string;
  className?: string;
  rounded?: string;
  onColours?: (c: Rgb[]) => void;
}) {
  const [failed, setFailed] = useState(false);
  const fallback = seededColours(title || '♪');
  if (!url || failed) {
    return (
      <div
        className={cn('relative flex items-center justify-center overflow-hidden', rounded, className)}
        style={{ background: `linear-gradient(135deg, ${css(fallback[0]!)}, ${css(fallback[1]!)} 55%, ${css(fallback[2]!)})` }}
        aria-hidden
      >
        <Music2 className="h-[38%] w-[38%] text-white/70" strokeWidth={1.5} />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      crossOrigin="anonymous"
      draggable={false}
      onError={() => setFailed(true)}
      onLoad={(e) => onColours?.(coloursOf(e.currentTarget))}
      className={cn('object-cover', rounded, className)}
    />
  );
}

export function AuroraArt({
  url,
  title,
  playing,
  className,
}: {
  url: string | null | undefined;
  title: string;
  playing: boolean;
  className?: string;
}) {
  // Colours belong to the cover they came from: a new song shows its fallback until its cover loads.
  const [colours, setColours] = useState<{ url: string | null | undefined; c: Rgb[] }>({ url: null, c: [] });
  const glow = colours.url === url && colours.c.length >= 2 ? colours.c : seededColours(title || '♪');

  return (
    <div className={cn('relative isolate aspect-square', className)}>
      <div aria-hidden className="absolute -inset-[18%] -z-10 overflow-visible">
        <div className="aurora-blob" style={{ width: '70%', height: '70%', left: '0%', top: '5%', background: css(glow[0]!, 0.85) }} />
        <div className="aurora-blob b2" style={{ width: '65%', height: '65%', right: '0%', top: '25%', background: css(glow[1]!, 0.75) }} />
        <div className="aurora-blob" style={{ width: '55%', height: '55%', left: '22%', bottom: '0%', background: css((glow[2] ?? glow[0])!, 0.6), animationDuration: '36s' }} />
      </div>
      <div
        className={cn(
          'h-full w-full transition-transform duration-[1200ms] ease-out',
          playing ? 'scale-100 motion-safe:animate-[breathe_7s_ease-in-out_infinite]' : 'scale-[0.94]',
        )}
      >
        <Cover
          url={url}
          title={title}
          onColours={(c) => setColours({ url, c })}
          rounded="rounded-[26px]"
          className="h-full w-full shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95),inset_0_0_0_1px_rgba(255,255,255,0.08)]"
        />
      </div>
    </div>
  );
}
