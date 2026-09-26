import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { uiLocale } from '@/i18n';
import { getSession, membershipQuery } from '@/lib/queries';

// Every signed-in screen lives under this pathless layout: session + household membership required.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await getSession();
    // Keep where the user was going (e.g. a scanned /s/HL:LOC:… label) so login can return there.
    if (!session) {
      throw redirect({ to: '/login', search: location.pathname === '/' ? {} : { redirect: location.href } });
    }
    // Offline with nothing saved on this phone yet: say so (the root error page shows "You're offline")
    // instead of waiting for a request that can't start.
    if (!navigator.onLine && context.queryClient.getQueryData(membershipQuery.queryKey) === undefined) {
      throw new Error('offline');
    }
    const membership = await context.queryClient.ensureQueryData(membershipQuery);
    if (!membership) throw redirect({ to: '/not-invited' });
    // Dates follow the person's UI language (Sinhala → si-LK); amounts stay en-LK (rule 4).
    const locale = uiLocale(membership.household.locale);
    return { membership: locale === membership.household.locale ? membership : { ...membership, household: { ...membership.household, locale } } };
  },
  component: AppLayout,
});

function AppLayout() {
  const { membership } = Route.useRouteContext();
  return (
    <AppShell membership={membership}>
      <Outlet />
    </AppShell>
  );
}
