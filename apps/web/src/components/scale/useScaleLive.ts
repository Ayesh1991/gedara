// One Realtime subscription per household for the kitchen scale (Phase 6b): new and changed readings
// and the scales' live state. The pop-ups (AppShell) and the Kitchen-scale page share it, so a screen
// never opens the same channel twice. Each reading's arrival time is remembered here: card shown −
// stable moment on the scale = the done-when's "within 2 s".
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';
import { invalidateScale, scalesQuery, type ScaleDevice, type ScaleReading } from '@/lib/scale/queries';
import { supabase } from '@/lib/supabase';

export type ReadingListener = (r: ScaleReading, kind: 'insert' | 'update') => void;

interface Sub {
  channel: RealtimeChannel;
  listeners: Set<ReadingListener>;
  qc: QueryClient;
}

const subs = new Map<string, Sub>();
const arrived = new Map<string, number>();

/** When this screen first heard of a reading (ms since epoch), if it arrived live. */
export function arrivedAt(readingId: string): number | undefined {
  return arrived.get(readingId);
}

function open(householdId: string, qc: QueryClient): Sub {
  const existing = subs.get(householdId);
  if (existing) return existing;
  const listeners = new Set<ReadingListener>();
  let refresh: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    // Several rows can land together (an offline batch): one refetch for all of them.
    if (refresh) return;
    refresh = setTimeout(() => {
      refresh = null;
      void invalidateScale(qc, householdId);
    }, 150);
  };
  const channel = supabase
    .channel(`scale-${householdId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'scale_reading', filter: `household_id=eq.${householdId}` },
      (p) => {
        const r = p.new as ScaleReading;
        if (!arrived.has(r.id)) arrived.set(r.id, Date.now());
        if (arrived.size > 200) arrived.delete(arrived.keys().next().value!);
        for (const l of listeners) l(r, 'insert');
        refreshSoon();
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'scale_reading', filter: `household_id=eq.${householdId}` },
      (p) => {
        for (const l of listeners) l(p.new as ScaleReading, 'update');
        refreshSoon();
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'device', filter: `household_id=eq.${householdId}` },
      (p) => {
        const d = p.new as ScaleDevice;
        // Live state changes many times a minute: patch the cache instead of refetching.
        qc.setQueryData(scalesQuery(householdId).queryKey, (old: ScaleDevice[] | undefined) =>
          old ? old.map((o) => (o.id === d.id ? { ...o, ...d } : o)) : old,
        );
      },
    )
    // Joined (or re-joined after a dropped connection): anything that happened before is fetched once,
    // so a reading or live state sent while the channel was connecting is never missed.
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void invalidateScale(qc, householdId);
    });
  const sub = { channel, listeners, qc };
  subs.set(householdId, sub);
  return sub;
}

function close(householdId: string, sub: Sub) {
  if (sub.listeners.size > 0 || subs.get(householdId) !== sub) return;
  subs.delete(householdId);
  void supabase.removeChannel(sub.channel);
}

/** Subscribe while mounted; `onReading` sees every new or changed reading of the household. */
export function useScaleLive(householdId: string, onReading?: ReadingListener, enabled = true) {
  const qc = useQueryClient();
  const handler = useRef(onReading);
  useEffect(() => {
    handler.current = onReading;
  }, [onReading]);

  useEffect(() => {
    if (!enabled) return;
    const sub = open(householdId, qc);
    const l: ReadingListener = (r, kind) => handler.current?.(r, kind);
    sub.listeners.add(l);
    return () => {
      sub.listeners.delete(l);
      // Let a remounting screen pick the channel up again before it is closed.
      setTimeout(() => close(householdId, sub), 1000);
    };
  }, [householdId, qc, enabled]);
}
