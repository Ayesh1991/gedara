import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { LONG_PRESS_MS, PRESS_SLOP_PX, dragOffset, lockAxis, releaseAction, type Axis } from '@/lib/pantry/swipe';

interface Options {
  enabled: boolean;
  allow: { right: boolean; left: boolean };
  onRight: () => void;
  onLeft: () => void;
  onLongPress: () => void;
}

/**
 * Touch gestures for a pantry card (rules in lib/pantry/swipe.ts). Touch / pen only: a mouse keeps
 * the buttons. The card element needs `touch-action: pan-y` so the browser still scrolls the list.
 */
export function useSwipe({ enabled, allow, onRight, onLeft, onLongPress }: Options) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const g = useRef<{ id: number; x: number; y: number; axis: Axis; width: number; timer: number | null; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  const clearTimer = () => {
    if (g.current?.timer) window.clearTimeout(g.current.timer);
    if (g.current) g.current.timer = null;
  };

  const end = () => {
    clearTimer();
    g.current = null;
    setDragging(false);
    setOffset(0);
  };

  if (!enabled) return { offset: 0, dragging: false, handlers: {} };

  return {
    offset,
    dragging,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (e.pointerType === 'mouse' || !e.isPrimary) return;
        const width = e.currentTarget.getBoundingClientRect().width;
        g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: 'none', width, timer: null, moved: false };
        g.current.timer = window.setTimeout(() => {
          if (!g.current || g.current.moved) return;
          swallowClick.current = true;
          navigator.vibrate?.(15);
          end();
          onLongPress();
        }, LONG_PRESS_MS);
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        const s = g.current;
        if (!s || e.pointerId !== s.id) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (Math.abs(dx) > PRESS_SLOP_PX || Math.abs(dy) > PRESS_SLOP_PX) {
          s.moved = true;
          clearTimer();
        }
        if (s.axis === 'none') {
          s.axis = lockAxis(dx, dy);
          if (s.axis === 'y') return end();
          if (s.axis === 'x') {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }
        }
        if (s.axis === 'x') setOffset(dragOffset(dx, s.width, allow));
      },
      onPointerUp(e: PointerEvent<HTMLElement>) {
        const s = g.current;
        if (!s || e.pointerId !== s.id) return;
        const action = s.axis === 'x' ? releaseAction(e.clientX - s.x, s.width, allow) : null;
        if (s.axis === 'x') swallowClick.current = true;
        end();
        if (action === 'right') onRight();
        if (action === 'left') onLeft();
      },
      onPointerCancel: end,
      // After a swipe or long-press, the lifted finger must not also open the product.
      onClickCapture(e: MouseEvent<HTMLElement>) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu(e: MouseEvent<HTMLElement>) {
        // Android's long-press menu on the link would cover ours.
        if (g.current || swallowClick.current) e.preventDefault();
      },
    },
  };
}
