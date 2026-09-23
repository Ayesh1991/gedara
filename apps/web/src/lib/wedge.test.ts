import { describe, expect, it, vi } from 'vitest';
import { createWedgeDetector } from './wedge';

function feed(detector: ReturnType<typeof createWedgeDetector>, clock: { t: number }, text: string, gapMs: number) {
  const results: boolean[] = [];
  for (const key of [...text, 'Enter']) {
    clock.t += gapMs;
    results.push(detector({ key }));
  }
  return results.at(-1);
}

describe('USB wedge detector', () => {
  it('reports a fast burst ending in Enter', () => {
    const clock = { t: 0 };
    const onScan = vi.fn();
    const d = createWedgeDetector({ onScan, now: () => clock.t });
    expect(feed(d, clock, 'HL:LOC:7K2P9Q', 8)).toBe(true);
    expect(onScan).toHaveBeenCalledWith('HL:LOC:7K2P9Q');
  });

  it('ignores human typing speed', () => {
    const clock = { t: 0 };
    const onScan = vi.fn();
    const d = createWedgeDetector({ onScan, now: () => clock.t });
    expect(feed(d, clock, 'HL:LOC:7K2P9Q', 120)).toBe(false);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores short bursts and modifier shortcuts', () => {
    const clock = { t: 0 };
    const onScan = vi.fn();
    const d = createWedgeDetector({ onScan, now: () => clock.t });
    expect(feed(d, clock, 'abc', 5)).toBe(false);
    clock.t += 5;
    d({ key: 'k', ctrlKey: true });
    expect(onScan).not.toHaveBeenCalled();
  });

  it('a slow key before the burst does not break it; Shift is ignored', () => {
    const clock = { t: 0 };
    const onScan = vi.fn();
    const d = createWedgeDetector({ onScan, now: () => clock.t });
    clock.t += 500;
    d({ key: 'x' });
    clock.t += 500;
    for (const key of ['Shift', ...'4792024000222', 'Enter']) {
      clock.t += 10;
      d({ key });
    }
    expect(onScan).toHaveBeenCalledWith('4792024000222');
  });
});
