import { Construction } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from './ui/card';

export function Placeholder({ title, description, phase }: { title: string; description: string; phase: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <Card className="flex items-start gap-3">
        <Construction className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div>
          <div className="font-display font-medium">{t('placeholder.comingIn', { phase })}</div>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
      </Card>
    </div>
  );
}
