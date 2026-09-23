import { useTranslation } from 'react-i18next';
import { env } from '@/lib/env';

export function Brand() {
  const { t } = useTranslation();
  const envLabel = t(`app.env.${env.VITE_APP_ENV}`);
  return (
    <div className="flex items-center gap-3">
      <img src="/icon.svg" alt="" className="h-9 w-9 rounded-[10px]" />
      <div className="leading-tight">
        <div className="font-display text-[20px] font-semibold">{t('app.name')}</div>
        <div className="text-[12px] text-muted">{t('app.subtitle')}</div>
      </div>
      {envLabel && (
        <span className="rounded-full border border-teal/40 px-2 py-0.5 tabular text-[10px] text-teal">
          {envLabel}
        </span>
      )}
    </div>
  );
}
