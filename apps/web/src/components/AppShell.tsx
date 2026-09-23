import { Link, type LinkProps } from '@tanstack/react-router';
import {
  ChartNoAxesColumn,
  House,
  MapPin,
  Package,
  ScanLine,
  Settings,
  ShoppingBasket,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Brand } from './Brand';
import { VersionBadge } from './VersionBadge';

type NavKey = 'home' | 'money' | 'scan' | 'pantry' | 'things' | 'places' | 'insights' | 'settings';

interface NavItem {
  key: NavKey;
  to: LinkProps['to'];
  icon: LucideIcon;
}

// Five tabs keep one-thumb reach (MASTER_PLAN §5.1). Scan sits in the centre and is the gold action.
const TABS: NavItem[] = [
  { key: 'home', to: '/', icon: House },
  { key: 'money', to: '/money', icon: Wallet },
  { key: 'scan', to: '/scan', icon: ScanLine },
  { key: 'pantry', to: '/pantry', icon: ShoppingBasket },
  { key: 'things', to: '/things', icon: Package },
];

const RAIL_EXTRA: NavItem[] = [
  { key: 'places', to: '/places', icon: MapPin },
  { key: 'insights', to: '/insights', icon: ChartNoAxesColumn },
  { key: 'settings', to: '/settings', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop / iPad landscape: left rail */}
      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:flex-col lg:border-r lg:border-line lg:bg-ink-2 lg:p-4">
        <Brand />
        <nav aria-label={t('nav.main')} className="mt-8 flex flex-1 flex-col gap-1">
          {[...TABS, ...RAIL_EXTRA].map((item) => (
            <Link
              key={item.key}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              className="flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-muted hover:bg-panel hover:text-text data-[status=active]:bg-panel data-[status=active]:text-text"
            >
              <item.icon className={item.key === 'scan' ? 'h-5 w-5 text-gold' : 'h-5 w-5'} aria-hidden />
              <span className="font-display">{t(`nav.${item.key}`)}</span>
            </Link>
          ))}
        </nav>
        <VersionBadge />
      </aside>

      <div className="flex min-h-dvh flex-1 flex-col">
        {/* Phone / iPad portrait: header */}
        <header className="pt-safe sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur-md lg:hidden">
          <div className="flex h-16 items-center justify-between px-4">
            <Brand />
            <Link to="/settings" aria-label={t('nav.settings')} className="rounded-full p-2 text-muted hover:text-text">
              <Settings className="h-6 w-6" aria-hidden />
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-[calc(var(--nav-h)+env(safe-area-inset-bottom)+2rem)] pt-5 lg:pb-10">
          {children}
          <footer className="mt-10 text-center lg:hidden">
            <VersionBadge />
          </footer>
        </main>

        {/* Phone / iPad portrait: bottom tab bar */}
        <nav
          aria-label={t('nav.main')}
          className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ink-2/90 backdrop-blur-md lg:hidden"
        >
          <ul className="mx-auto grid h-[var(--nav-h)] max-w-xl grid-cols-5">
            {TABS.map((item) => (
              <li key={item.key} className="flex">
                {item.key === 'scan' ? (
                  <Link
                    to={item.to}
                    className="mx-auto -mt-5 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-gold text-primary-foreground shadow-[0_0_28px_var(--gold-soft)]"
                  >
                    <item.icon className="h-7 w-7" aria-hidden />
                    <span className="sr-only">{t(`nav.${item.key}`)}</span>
                  </Link>
                ) : (
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.to === '/' }}
                    className="flex flex-1 flex-col items-center justify-center gap-1 text-[10.5px] text-muted data-[status=active]:text-text"
                  >
                    <item.icon className="h-6 w-6" aria-hidden />
                    {t(`nav.${item.key}`)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
