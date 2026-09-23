import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { getSession, membershipQuery } from '@/lib/queries';

// Every signed-in screen lives under this pathless layout: session + household membership required.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await getSession();
    // Keep where the user was going (e.g. a scanned /s/HL:LOC:… label) so login can return there.
    if (!session) {
      throw redirect({ to: '/login', search: location.pathname === '/' ? {} : { redirect: location.href } });
    }
    const membership = await context.queryClient.ensureQueryData(membershipQuery);
    if (!membership) throw redirect({ to: '/not-invited' });
    return { membership };
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
