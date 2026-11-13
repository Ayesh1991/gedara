import { createFileRoute, redirect } from '@tanstack/react-router';
import { QuickScreen } from '@/components/quick/QuickScreen';
import type { Identity } from '@/components/quick/useQuick';
import { getSession, membershipQuery } from '@/lib/queries';
import '@/lib/quick/install'; // catch the browser's install offer early
import { loadSnapshot } from '@/lib/quick/state';

// Quick spend (Phase 12) lives outside the signed-in shell on purpose: opened from its own
// home-screen icon it must show the pad at once, with no signal and even with an expired login.
// It needs only "who is this" — from the saved session, the saved membership or, failing both,
// the small copy Quick spend keeps on the phone. Entries made without a login wait until sign-in.
export const Route = createFileRoute('/quick')({
  beforeLoad: async ({ context }) => {
    const [session, snapshot] = await Promise.all([getSession(), loadSnapshot()]);
    if (!session && !snapshot) throw redirect({ to: '/login', search: { redirect: '/quick' } });

    const mine = snapshot && (!session || snapshot.userId === session.user.id) ? snapshot : null;
    const saved = context.queryClient.getQueryData(membershipQuery.queryKey);
    let identity: Identity | null = saved
      ? { userId: saved.userId, householdId: saved.household.id, role: saved.role, name: saved.displayName, timezone: saved.household.timezone }
      : mine
        ? { userId: mine.userId, householdId: mine.householdId, role: mine.role, name: mine.name, timezone: mine.timezone }
        : null;
    if (!identity) {
      // First time on this phone: the membership has to come from the network once.
      if (!navigator.onLine) throw new Error('offline');
      const m = await context.queryClient.ensureQueryData(membershipQuery);
      if (!m) throw redirect({ to: '/not-invited' });
      identity = { userId: m.userId, householdId: m.household.id, role: m.role, name: m.displayName, timezone: m.household.timezone };
    }
    const first = identity.name?.trim().split(/\s+/)[0] ?? null;
    return { identity: { ...identity, name: first }, signedIn: Boolean(session), snapshot: mine && mine.householdId === identity.householdId ? mine : null };
  },
  component: QuickPage,
});

function QuickPage() {
  const { identity, signedIn, snapshot } = Route.useRouteContext();
  return <QuickScreen identity={identity} signedIn={signedIn} snapshot={snapshot} />;
}
