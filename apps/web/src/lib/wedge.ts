// USB barcode scanners in keyboard-wedge mode "type" the code very fast and press Enter.
// Humans don't type 6+ characters with < 50 ms between every key (scanners: ~5–15 ms), so a fast burst ending in
// Enter/Tab is a scan. Works from any screen (MASTER_PLAN §5.2 Scan HUD).

export interface WedgeOptions {
  onScan: (text: string) => void;
  maxGapMs?: number;
  minLength?: number;
  now?: () => number;
}

export interface WedgeKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function createWedgeDetector({ onScan, maxGapMs = 50, minLength = 6, now = () => performance.now() }: WedgeOptions) {
  let buffer = '';
  let last = -Infinity;

  /** Feed every keydown. Returns true when the key completed a scan (caller should preventDefault). */
  return function handleKey(e: WedgeKey): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      buffer = '';
      return false;
    }
    const t = now();
    const gap = t - last;
    last = t;

    if (e.key === 'Enter' || e.key === 'Tab') {
      const text = buffer;
      buffer = '';
      if (text.length >= minLength && gap <= maxGapMs * 3) {
        onScan(text);
        return true;
      }
      return false;
    }
    if (e.key.length !== 1) {
      // Shift inside a burst doesn't break it; a slow Shift/arrow starts over.
      if (gap > maxGapMs) buffer = '';
      return false;
    }
    buffer = gap <= maxGapMs ? buffer + e.key : e.key;
    return false;
  };
}

/** Typing in a field is left alone unless the field opts in with data-scan-input. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.dataset.scanInput !== undefined) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
