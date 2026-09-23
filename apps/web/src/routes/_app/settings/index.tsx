import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronRight, Stethoscope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';

export const Route = createFileRoute('/_app/settings/')({
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-semibold">{t('settings.title')}</h1>

      <Link to="/settings/diagnostics" className="block">
        <Card className="flex items-center gap-3 hover:border-gold/40">
          <Stethoscope className="h-5 w-5 text-teal" aria-hidden />
          <div className="flex-1">
            <div className="font-display font-medium">{t('settings.diagnostics')}</div>
            <div className="text-sm text-muted">{t('settings.diagnosticsHint')}</div>
          </div>
          <ChevronRight className="h-5 w-5 text-muted" aria-hidden />
        </Card>
      </Link>

      <Card className="space-y-3">
        <div className="text-sm">{t('settings.signedInAs', { email: membership.email })}</div>
        <div className="text-sm text-muted">{t('settings.role', { role: membership.role })}</div>
        <Button variant="destructive" className="w-full" onClick={() => void supabase.auth.signOut()}>
          {t('settings.signOut')}
        </Button>
      </Card>
    </div>
  );
}
