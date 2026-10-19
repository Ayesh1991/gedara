// One Realtime channel per household for the House page (Phase 8): Home Assistant's doors, windows,
// lights, switches and AC as the bridge reports them, patched straight into the cache (a window
// opening shows within a second), and the bridge coming online. Shared by every screen that shows
// the house, so it's never opened twice.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { bridgeQuery, entitiesQuery, invalidateHome, type Bridge, type HomeEntity } from '@/lib/home/queries';
import { supabase } from '@/lib/supabase';

interface Sub {
  channel: RealtimeChannel;
  users: number;
}

const subs = new Map<string, Sub>();

function open(householdId: string, qc: QueryClient): Sub {
  const existing = subs.get(householdId);
  if (existing) return existing;
  const channel = supabase
    .channel(`home-${householdId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'home_entity', filter: `household_id=eq.${householdId}` }, (p) => {
      if (p.eventType === 'DELETE') {
        const gone = (p.old as { id?: string } | undefined)?.id;
        qc.setQueryData(entitiesQuery(householdId).queryKey, (old: HomeEntity[] | undefined) => (old ?? []).filter((e) => e.id !== gone));
        return;
      }
      const row = p.new as HomeEntity | undefined;
      if (!row?.id) return;
      qc.setQueryData(entitiesQuery(householdId).queryKey, (old: HomeEntity[] | undefined) => {
        const list = old ?? [];
        return list.some((e) => e.id === row.id) ? list.map((e) => (e.id === row.id ? row : e)) : [...list, row];
      });
    })
    // The bridge's own row (last seen, status): patched from the message, no refetch (log budget);
    // the speaker's and the scale's updates are ignored here.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'device', filter: `household_id=eq.${householdId}` }, (p) => {
      const row = p.new as (Partial<Bridge> & { kind?: string; revoked_at?: string | null }) | undefined;
      if (row?.kind !== 'home') return;
      if (row.revoked_at) return void invalidateHome(qc, householdId);
      qc.setQueryData(bridgeQuery(householdId).queryKey, (old: Bridge | null | undefined) =>
        old && old.id === row.id
          ? { ...old, name: row.name ?? old.name, last_seen_at: row.last_seen_at ?? old.last_seen_at, fw_version: row.fw_version ?? old.fw_version, status: row.status ?? old.status }
          : old,
      );
    })
    // Joined (or re-joined): fetch once, so nothing sent while connecting is missed.
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void invalidateHome(qc, householdId);
    });
  const sub = { channel, users: 0 };
  subs.set(householdId, sub);
  return sub;
}

export function useHomeLive(householdId: string, enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const sub = open(householdId, qc);
    sub.users++;
    return () => {
      sub.users--;
      setTimeout(() => {
        if (sub.users > 0 || subs.get(householdId) !== sub) return;
        subs.delete(householdId);
        void supabase.removeChannel(sub.channel);
      }, 1000);
    };
  }, [householdId, qc, enabled]);
}
