import { useTranslation } from 'react-i18next';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

export function LogoMark({ size = 42, className }: { size?: number; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('brand-gradient flex shrink-0 items-center justify-center', className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.31,
        boxShadow: '0 10px 32px -8px color-mix(in srgb, var(--glow) 75%, transparent), inset 0 1px 0 rgba(255,255,255,0.35)',
      }}
    >
      <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="#05070F">
        <path d="M12 3 21 10.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.8z" />
      </svg>
    </div>
  );
}

export function EnvChip() {
  const { t } = useTranslation();
  const label = t(`app.env.${env.VITE_APP_ENV}`);
  if (!label) return null;
  return (
    <span className="tabular rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10px] tracking-[0.12em] text-teal">
      {label}
    </span>
  );
}

export function Brand() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <LogoMark size={40} />
      <div className="leading-tight">
        <div className="font-display text-[20px] font-bold tracking-tight">{t('app.name')}</div>
        <div className="text-[12px] text-muted">{t('app.subtitle')}</div>
      </div>
      <EnvChip />
    </div>
  );
}
