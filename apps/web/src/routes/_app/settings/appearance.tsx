import { createFileRoute } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { MOTION_MODES, type MotionMode } from '@/theme/prefs';
import { THEME_IDS, THEMES, type ThemeId } from '@/theme/themes';
import { useTheme } from '@/theme/ThemeProvider';

export const Route = createFileRoute('/_app/settings/appearance')({
  component: AppearancePage,
});

/** Arrow-key navigation for a radio group (WAI-ARIA radio pattern). */
function useRadioKeys<T extends string>(values: readonly T[], current: T, select: (v: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const next = (values.indexOf(current) + delta + values.length) % values.length;
    select(values[next]!);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

function ThemePreview({ id }: { id: ThemeId }) {
  const th = THEMES[id];
  return (
    <div aria-hidden className="relative h-24 overflow-hidden rounded-xl bg-[#05070f]">
      <div className="absolute -top-6 -left-4 h-20 w-20 rounded-full blur-xl" style={{ background: th.aur[0], opacity: 0.8 }} />
      <div className="absolute -top-2 -right-4 h-16 w-16 rounded-full blur-xl" style={{ background: th.aur[1], opacity: 0.7 }} />
      <div className="absolute -bottom-8 left-1/3 h-20 w-24 rounded-full blur-xl" style={{ background: th.aur[2], opacity: 0.6 }} />
      <div className="absolute right-3 bottom-3 left-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full" style={{ background: `linear-gradient(90deg, ${th.accentA}, ${th.accentB})` }} />
        <div className="h-4 w-8 rounded-md bg-[#f5b83d]" />
      </div>
    </div>
  );
}

function AppearancePage() {
  const { t } = useTranslation();
  const { prefs, setPrefs } = useTheme();
  const themeKeys = useRadioKeys<ThemeId>(THEME_IDS, prefs.theme, (theme) => setPrefs({ theme }));
  const motionKeys = useRadioKeys<MotionMode>(MOTION_MODES, prefs.motion, (motion) => setPrefs({ motion }));

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('appearance.title')}</h1>

      <Card className="flex flex-col gap-4">
        <div className="space-y-1">
          <h2 id="theme-label" className="font-display text-[17px] font-semibold">
            {t('appearance.theme')}
          </h2>
          <p className="text-[13.5px] text-[#a5b0d0]">{t('appearance.themeHint')}</p>
        </div>
        <div role="radiogroup" aria-labelledby="theme-label" className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {THEME_IDS.map((id, i) => {
            const selected = prefs.theme === id;
            return (
              <button
                key={id}
                ref={(el) => {
                  themeKeys.refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                data-theme-option={id}
                onClick={() => setPrefs({ theme: id })}
                onKeyDown={themeKeys.onKeyDown}
                className={cn(
                  'flex flex-col gap-2.5 rounded-2xl border p-2.5 text-left transition-[border-color,box-shadow]',
                  selected
                    ? 'border-accent-a shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent-a)_25%,transparent),0_0_30px_color-mix(in_srgb,var(--glow)_30%,transparent)]'
                    : 'border-line-2 hover:border-white/25',
                )}
              >
                <ThemePreview id={id} />
                <div className="flex items-start justify-between gap-2 px-1 pb-0.5">
                  <div className="min-w-0">
                    <div className="font-display text-[15px] font-semibold">{t(`appearance.themes.${id}.name`)}</div>
                    <div className="truncate text-xs text-muted">{t(`appearance.themes.${id}.desc`)}</div>
                  </div>
                  {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-b" aria-hidden />}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="space-y-1">
          <h2 id="motion-label" className="font-display text-[17px] font-semibold">
            {t('appearance.motion')}
          </h2>
          <p className="text-[13.5px] text-[#a5b0d0]">{t('appearance.motionHint')}</p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="motion-label"
          className="grid grid-cols-3 gap-1 rounded-2xl border border-line bg-white/[0.04] p-1"
        >
          {MOTION_MODES.map((m, i) => {
            const selected = prefs.motion === m;
            return (
              <button
                key={m}
                ref={(el) => {
                  motionKeys.refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                data-motion-option={m}
                onClick={() => setPrefs({ motion: m })}
                onKeyDown={motionKeys.onKeyDown}
                className={cn(
                  'h-11 rounded-xl text-sm transition-colors',
                  selected ? 'accent-pill text-text' : 'text-muted hover:text-text',
                )}
              >
                {t(`appearance.motionModes.${m}`)}
              </button>
            );
          })}
        </div>
      </Card>

      <p className="text-center text-xs text-muted">{t('appearance.synced')}</p>
    </div>
  );
}
