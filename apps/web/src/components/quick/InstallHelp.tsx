// "Add the Quick spend icon": what this device can do, step by step. On /quick the page already
// carries Quick spend's own manifest and touch icon (index.html), so Install / Add to Home Screen
// here makes the Quick spend icon, not a second Gedara.
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { canInstall, onInstallChange, promptInstall } from '@/lib/quick/install';
import { platform } from '@/lib/quick/merge';

export default function InstallHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const canPrompt = useSyncExternalStore(onInstallChange, canInstall, () => false);
  const kind = platform(navigator.userAgent, navigator.maxTouchPoints);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  const steps =
    kind === 'ios'
      ? [t('quick.install.ios1'), t('quick.install.ios2'), t('quick.install.ios3'), t('quick.install.ios4')]
      : kind === 'android'
        ? [t('quick.install.android1'), t('quick.install.android2'), t('quick.install.android3')]
        : [t('quick.install.other1'), t('quick.install.other2')];

  return (
    <Sheet open onClose={onClose} title={t('quick.install.title')}>
      <div className="flex flex-col gap-4 text-[14px]">
        {standalone && <p className="rounded-xl bg-teal/[0.08] px-3 py-2 text-teal">{t('quick.install.already')}</p>}
        {canPrompt && (
          <Button
            variant="accent"
            onClick={() => void promptInstall()}
          >
            {t('quick.install.button')}
          </Button>
        )}
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {kind === 'android' && (
          <div>
            <p className="mb-1.5 font-semibold">{t('quick.install.shortcutTitle')}</p>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>{t('quick.install.shortcut1')}</li>
              <li>{t('quick.install.shortcut2')}</li>
            </ol>
          </div>
        )}
        {kind === 'ios' && <p className="text-[13px] text-muted">{t('quick.install.iosNote')}</p>}
      </div>
    </Sheet>
  );
}
