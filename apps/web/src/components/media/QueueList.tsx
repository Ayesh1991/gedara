// Up next (Phase 7h): the songs after the one playing. Drag a row by its handle to reorder (mouse,
// touch or pen), or use the arrow buttons / keyboard; ✕ takes a song out of the queue. Each change is
// one command to the speaker, which owns the queue.
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '@/lib/media/progress';
import type { Track } from '@/lib/media/queries';
import { cn } from '@/lib/utils';
import { Cover } from './AuroraArt';
import type { SpeakerView } from './useSpeaker';

const ROW = 60;

export function QueueList({ view, canWrite }: { view: SpeakerView; canWrite: boolean }) {
  const { t } = useTranslation();
  const p = view.player;
  const [drag, setDrag] = useState<{ from: number; dy: number } | null>(null);
  const start = useRef(0);
  if (!p || p.queue_index == null) return null;
  const after = p.queue
    .map((id, i) => ({ id, i, track: view.trackById.get(id) }))
    .filter((x): x is { id: string; i: number; track: Track } => x.i > p.queue_index! && !!x.track)
    .slice(0, 50);
  if (!after.length) return null;
  const disabled = !canWrite || !view.online;
  const move = (from: number, to: number) => {
    if (from === to || to <= p.queue_index! || to >= p.queue.length) return;
    void view.command('queue_move', { from, to });
  };
  const target = drag ? Math.max(0, Math.min(after.length - 1, after.findIndex((x) => x.i === drag.from) + Math.round(drag.dy / ROW))) : -1;

  return (
    <section aria-label={t('music.queue.title')} className="flex flex-col gap-2">
      <h2 className="font-display text-[18px] font-semibold">{t('music.queue.title')}</h2>
      <ol className="flex flex-col">
        {after.map((x, pos) => {
          const dragging = drag?.from === x.i;
          return (
            <li
              key={`${x.id}-${x.i}`}
              className={cn(
                'flex h-[60px] items-center gap-2 rounded-2xl px-1.5 transition-colors',
                dragging ? 'relative z-10 bg-panel-2 shadow-2xl' : target === pos && drag ? 'bg-white/[0.05]' : '',
              )}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              <button
                type="button"
                disabled={disabled}
                aria-label={t('music.queue.drag', { title: x.track.title })}
                className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-faint active:cursor-grabbing disabled:opacity-30"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  start.current = e.clientY;
                  setDrag({ from: x.i, dy: 0 });
                }}
                onPointerMove={(e) => drag && setDrag({ from: drag.from, dy: e.clientY - start.current })}
                onPointerUp={() => {
                  if (drag) move(drag.from, after[target]?.i ?? drag.from);
                  setDrag(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' && pos > 0) move(x.i, after[pos - 1]!.i);
                  if (e.key === 'ArrowDown' && pos < after.length - 1) move(x.i, after[pos + 1]!.i);
                }}
              >
                <GripVertical className="h-5 w-5" aria-hidden />
              </button>
              <Cover url={view.artUrl(x.track.art_path)} title={x.track.title} className="h-10 w-10 shrink-0" rounded="rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px]">{x.track.title}</span>
                <span className="block truncate text-[12.5px] text-muted">{x.track.artist ?? t('music.library.unknownArtist')}</span>
              </span>
              <span className="tabular hidden text-[12px] text-faint sm:inline">{formatTime(x.track.duration_s)}</span>
              <span className="hidden lg:flex">
                <button type="button" disabled={disabled || pos === 0} onClick={() => move(x.i, after[pos - 1]!.i)} aria-label={t('music.queue.up')} className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5 disabled:opacity-30">
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </button>
                <button type="button" disabled={disabled || pos === after.length - 1} onClick={() => move(x.i, after[pos + 1]!.i)} aria-label={t('music.queue.down')} className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5 disabled:opacity-30">
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </button>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void view.command('queue_remove', { index: x.i })}
                aria-label={t('music.queue.remove', { title: x.track.title })}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-white/5 disabled:opacity-30"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
