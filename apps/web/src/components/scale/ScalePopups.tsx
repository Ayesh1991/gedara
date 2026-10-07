// Kitchen-scale pop-ups on every screen (Phase 6b, Didula: page + pop-up with Undo). A new reading slides
// up as a card; plain results leave after 8 s, questions (refill, new tag) stay until handled or
// closed. Each device has its own switch (localStorage: a per-device convenience, never data). The
// Kitchen-scale page shows readings itself, so no pop-ups there.
import { useRouterState } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { needsAction } from '@/lib/scale/format';
import type { ScaleReading } from '@/lib/scale/queries';
import { ReadingCard } from './ReadingCard';
import { useScaleLive } from './useScaleLive';

const KEY = 'gedara.scale.popups';
const PLAIN_MS = 8000;
const SHOWN: ReadonlySet<string> = new Set([
  'consumed', 'refilled', 'needs_decision', 'unknown_tag', 'tare_set', 'no_tare', 'no_product', 'below_tare', 'error',
]);

export function popupsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setPopupsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // private mode: stays on for this visit
  }
  window.dispatchEvent(new Event('gedara-scale-popups'));
}

export function ScalePopups({ householdId, canWrite }: { householdId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const onScalePage = useRouterState({ select: (s) => s.location.pathname === '/pantry/scale' });
  const [enabled, setEnabled] = useState(popupsEnabled);
  const [cards, setCards] = useState<ScaleReading[]>([]);

  useEffect(() => {
    const sync = () => setEnabled(popupsEnabled());
    window.addEventListener('gedara-scale-popups', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('gedara-scale-popups', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const dismiss = useCallback((id: string) => setCards((cs) => cs.filter((c) => c.id !== id)), []);

  const onReading = useCallback(
    (r: ScaleReading, kind: 'insert' | 'update') => {
      if (kind === 'update') {
        // A decision elsewhere (another phone) settles the card here too.
        setCards((cs) => cs.flatMap((c) => (c.id !== r.id ? [c] : needsAction(r.status) ? [{ ...c, ...r }] : [])));
        return;
      }
      if (!SHOWN.has(r.status)) return;
      setCards((cs) => [r, ...cs.filter((c) => c.id !== r.id)].slice(0, 3));
      if (!needsAction(r.status)) setTimeout(() => dismiss(r.id), PLAIN_MS);
    },
    [dismiss],
  );

  const active = enabled && !onScalePage;
  useScaleLive(householdId, onReading, active);
  if (!active || cards.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-2 px-3 lg:right-6 lg:bottom-6 lg:left-auto lg:w-[420px] lg:items-stretch"
      aria-live="polite"
      data-testid="scale-popups"
    >
      {cards.map((c) => (
        <div key={c.id} className="pointer-events-auto relative w-full max-w-md motion-safe:animate-[slide-up_.25s_ease-out]">
          <ReadingCard reading={c} householdId={householdId} canWrite={canWrite} onHandled={() => dismiss(c.id)} className="pr-11 shadow-2xl" />
          <button
            type="button"
            onClick={() => dismiss(c.id)}
            aria-label={t('common.close')}
            className="absolute top-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-white/5"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
