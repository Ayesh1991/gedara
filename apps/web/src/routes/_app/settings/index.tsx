import { Link, createFileRoute, type LinkProps } from '@tanstack/react-router';
import { ChevronRight, MapPin, Palette, Stethoscope, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';

export const Route = createFileRoute('/_app/settings/')({
  component: SettingsPage,
});

function SettingsLink({
  to,
  icon: Icon,
  title,
  hint,
}: {
  to: LinkProps['to'];
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <Link to={to} className="block">
      <Card className="flex items-center gap-4 transition-colors hover:border-white/25">
        <div className="brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#05070F]">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold">{title}</div>
          <div className="text-sm text-muted">{hint}</div>
        </div>
        <ChevronRight className="h-5 w-5 text-muted" aria-hidden />
      </Card>
    </Link>
  );
}

function SettingsPage() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('settings.title')}</h1>

      <SettingsLink to="/places" icon={MapPin} title={t('nav.places')} hint={t('settings.placesHint')} />
      <SettingsLink
        to="/settings/appearance"
        icon={Palette}
        title={t('settings.appearance')}
        hint={t('settings.appearanceHint')}
      />
      <SettingsLink
        to="/settings/diagnostics"
        icon={Stethoscope}
        title={t('settings.diagnostics')}
        hint={t('settings.diagnosticsHint')}
      />

      <Card className="space-y-3">
        <div className="text-sm">{t('settings.signedInAs', { email: membership.email })}</div>
        <div className="text-sm text-muted">{t('settings.role', { role: t(`shell.roles.${membership.role}`) })}</div>
        <Button variant="destructive" className="w-full" onClick={() => void supabase.auth.signOut()}>
          {t('settings.signOut')}
        </Button>
      </Card>
    </div>
  );
}
