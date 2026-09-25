import { useTranslation } from 'react-i18next';
import { Sheet } from './ui/sheet';

const ROWS: [string[], string][] = [
  [['⌘', 'K'], 'palette'],
  [['/'], 'search'],
  [['N'], 'new'],
  [['S'], 'scan'],
  [['G', 'H'], 'home'],
  [['G', 'M'], 'money'],
  [['G', 'P'], 'pantry'],
  [['G', 'T'], 'things'],
  [['G', 'L'], 'places'],
  [['G', 'I'], 'insights'],
  [['G', 'A'], 'attention'],
  [['?'], 'help'],
];

/** "?" — the keyboard shortcuts (desktop / iPad with a keyboard). */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t('shortcuts.title')}>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2.5 text-[14.5px]">
        {ROWS.map(([keys, what]) => (
          <div key={what} className="contents">
            <dt className="flex gap-1">
              {keys.map((k) => (
                <kbd key={k} className="tabular min-w-7 rounded-md border border-line-2 bg-white/5 px-1.5 py-0.5 text-center text-[12.5px]">
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className="text-muted">{t(`shortcuts.${what as 'palette'}`)}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
