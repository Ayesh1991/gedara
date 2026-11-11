// One Realtime subscription per household for the bin scanner (Phase 11): new and changed scans and
// the scanners' own rows (online, paused). The pop-ups (AppShell) and the Bin-scanner pages share it,
// so a screen never opens the same channel twice. No polling: the scanner itself only calls when
// something is scanned (log budget).
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';
import { invalidateScanner, scannersQuery, type BinScan, type ScannerDevice } from '@/lib/scanner/queries';
import { supabase } from '@/lib/supabase';

export type ScanListener = (s: BinScan, kind: 'insert' | 'update') => void;

interface Sub {
  channel: RealtimeChannel;
  listeners: Set<ScanListener>;
}

const subs = new Map<string, Sub>();

function open(householdId: string, qc: QueryClient): Sub {
  const existing = subs.get(householdId);
  if (existing) return existing;
  const listeners = new Set<ScanListener>();
  let refresh: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    // Several rows can land together (an offline batch): one refetch for all of them.
    if (refresh) return;
    refresh = setTimeout(() => {
      refresh = null;
      void invalidateScanner(qc, householdId);
    }, 150);
  };
  const channel = supabase
    .channel(`scanner-${householdId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bin_scan', filter: `household_id=eq.${householdId}` }, (p) => {
      for (const l of listeners) l(p.new as BinScan, 'insert');
      refreshSoon();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bin_scan', filter: `household_id=eq.${householdId}` }, (p) => {
      for (const l of listeners) l(p.new as BinScan, 'update');
      refreshSoon();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'device', filter: `household_id=eq.${householdId}` }, (p) => {
      const d = p.new as ScannerDevice & { kind?: string };
      if (d.kind !== 'scanner') return;
      qc.setQueryData(scannersQuery(householdId).queryKey, (old: ScannerDevice[] | undefined) =>
        old ? old.map((o) => (o.id === d.id ? { ...o, ...d } : o)) : old,
      );
    })
    // Joined (or re-joined after a dropped connection): anything that happened before is fetched once.
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void qc.invalidateQueries({ queryKey: ['scanner', householdId] });
    });
  const sub = { channel, listeners };
  subs.set(householdId, sub);
  return sub;
}

function close(householdId: string, sub: Sub) {
  if (sub.listeners.size > 0 || subs.get(householdId) !== sub) return;
  subs.delete(householdId);
  void supabase.removeChannel(sub.channel);
}

/** Subscribe while mounted; `onScan` sees every new or changed scan of the household. */
export function useScannerLive(householdId: string, onScan?: ScanListener, enabled = true) {
  const qc = useQueryClient();
  const handler = useRef(onScan);
  useEffect(() => {
    handler.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;
    const sub = open(householdId, qc);
    const l: ScanListener = (s, kind) => handler.current?.(s, kind);
    sub.listeners.add(l);
    return () => {
      sub.listeners.delete(l);
      // Let a remounting screen pick the channel up again before it is closed.
      setTimeout(() => close(householdId, sub), 1000);
    };
  }, [householdId, qc, enabled]);
}
