import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { getSession, membershipQuery } from '@/lib/queries';

// Every signed-in screen lives under this pathless layout: session + household membership required.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    const session = await getSession();
    if (!session) throw redirect({ to: '/login' });
    const membership = await context.queryClient.ensureQueryData(membershipQuery);
    if (!membership) throw redirect({ to: '/not-invited' });
    return { membership };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
