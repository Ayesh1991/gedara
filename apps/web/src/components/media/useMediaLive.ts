// One Realtime channel per household for Gedara Music (Phase 7h): the speaker's player state (patched
// into the cache, so the mini player and the Music page follow it at once), songs arriving or
// changing state (the library refreshes), and speakers coming online. Shared by the mini player
// (AppShell) and the Music page, so a screen never opens the same channel twice.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { invalidateMedia, normalisePlayer, playersQuery, type Player } from '@/lib/media/queries';
import { onUploadSent } from '@/lib/media/upload';
import { supabase } from '@/lib/supabase';

interface Sub {
  channel: RealtimeChannel;
  users: number;
}

const subs = new Map<string, Sub>();

function open(householdId: string, qc: QueryClient): Sub {
  const existing = subs.get(householdId);
  if (existing) return existing;
  let refresh: ReturnType<typeof setTimeout> | null = null;
  const tracksSoon = () => {
    if (refresh) return;
    refresh = setTimeout(() => {
      refresh = null;
      void invalidateMedia(qc, householdId, 'tracks');
    }, 300);
  };
  const channel = supabase
    .channel(`media-${householdId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'media_player', filter: `household_id=eq.${householdId}` }, (p) => {
      const row = p.new as Player | undefined;
      if (!row?.device_id) return;
      const next = normalisePlayer(row);
      qc.setQueryData(playersQuery(householdId).queryKey, (old: Player[] | undefined) => {
        const list = old ?? [];
        return list.some((o) => o.device_id === next.device_id) ? list.map((o) => (o.device_id === next.device_id ? next : o)) : [...list, next];
      });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'media_track', filter: `household_id=eq.${householdId}` }, tracksSoon)
    // Only speakers' rows (not the Home Assistant bridge's or the scale's check-ins: log budget).
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'device', filter: `household_id=eq.${householdId}` }, (p) => {
      if ((p.new as { kind?: string } | undefined)?.kind === 'media') void invalidateMedia(qc, householdId, 'speakers');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'media_bt_device', filter: `household_id=eq.${householdId}` }, () =>
      invalidateMedia(qc, householdId, 'bt'),
    )
    // Joined (or re-joined): fetch once, so nothing sent while connecting is missed.
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void invalidateMedia(qc, householdId);
    });
  const sub = { channel, users: 0 };
  subs.set(householdId, sub);
  onUploadSent((h) => void invalidateMedia(qc, h, 'tracks'));
  return sub;
}

export function useMediaLive(householdId: string, enabled = true) {
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
