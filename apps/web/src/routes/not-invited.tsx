import { createFileRoute, redirect } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Brand } from '@/components/Brand';
import { VersionBadge } from '@/components/VersionBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getSession } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

export const Route = createFileRoute('/not-invited')({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: '/login' });
    return { email: session.user.email ?? '' };
  },
  component: NotInvited,
});

function NotInvited() {
  const { t } = useTranslation();
  const { email } = Route.useRouteContext();
  return (
    <div className="pt-safe flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <Brand />
        <Card className="space-y-4">
          <h1 className="font-display text-xl font-semibold">{t('notInvited.title')}</h1>
          <p className="text-sm text-muted">{t('notInvited.body', { email })}</p>
          <Button className="w-full" onClick={() => void supabase.auth.signOut()}>
            {t('notInvited.signOut')}
          </Button>
        </Card>
        <div className="text-center">
          <VersionBadge linked={false} />
        </div>
      </div>
    </div>
  );
}
