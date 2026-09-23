import { useEffect, useState } from 'react';
import { countUpValue } from '@/lib/countUp';
import { useTheme } from '@/theme/ThemeProvider';

/** Counts from 0 up to `target` on mount/change; returns `target` at once when motion is off. */
export function useCountUp(target: number, durationMs = 1400): number {
  const { motion } = useTheme();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!motion) return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      setValue(countUpValue(target, elapsed, durationMs));
      if (elapsed < durationMs) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, motion]);

  return motion ? value : target;
}
