import { Link, createFileRoute } from '@tanstack/react-router';
import { ChartNoAxesColumn, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';

export const Route = createFileRoute('/_app/')({
  component: Home,
});

function Home() {
  const { t } = useTranslation();
  const { membership } = Route.useRouteContext();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-semibold">
          {t('home.greeting', { household: membership.household.name })}
        </h1>
        <p className="mt-1 text-sm text-muted">{t('home.phase0')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Link to="/places">
          <Card className="flex items-center gap-3 hover:border-gold/40">
            <MapPin className="h-5 w-5 text-teal" aria-hidden />
            <span className="font-display">{t('home.openPlaces')}</span>
          </Card>
        </Link>
        <Link to="/insights">
          <Card className="flex items-center gap-3 hover:border-gold/40">
            <ChartNoAxesColumn className="h-5 w-5 text-teal" aria-hidden />
            <span className="font-display">{t('home.openInsights')}</span>
          </Card>
        </Link>
      </div>
    </div>
  );
}
