import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from './ui/card';

export function Placeholder({
  title,
  description,
  phase,
  icon: Icon,
}: {
  title: string;
  description: string;
  phase: string;
  icon: LucideIcon;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{title}</h1>
      <Card className="relative flex items-center gap-5 overflow-hidden p-6">
        <div
          aria-hidden
          className="absolute -top-16 -right-16 h-48 w-48 rounded-full opacity-40 blur-3xl"
          style={{ background: 'var(--glow)' }}
        />
        <div className="brand-gradient relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-[#05070F]">
          <Icon className="h-7 w-7" aria-hidden />
        </div>
        <div className="relative">
          <div className="tabular text-[11px] tracking-[0.14em] text-accent-b uppercase">
            {t('placeholder.comingIn', { phase })}
          </div>
          <p className="mt-1.5 text-[15px] text-[#c5cce3]">{description}</p>
        </div>
      </Card>
    </div>
  );
}
