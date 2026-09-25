import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState, type LinkProps } from '@tanstack/react-router';
import {
  Bell as BellIcon,
  ChartNoAxesColumn,
  House,
  MapPin,
  Package,
  ScanLine,
  Search,
  Settings,
  ShoppingBasket,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { knownItems } from '@/lib/attention';
import { attentionQuery } from '@/lib/insights/queries';
import type { Membership } from '@/lib/queries';
import { createShortcutReader, isTypingTarget, newTargetFor } from '@/lib/shortcuts';
import { initials, longDate } from '@/lib/time';
import { Brand, EnvChip, LogoMark } from './Brand';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { WedgeListener } from './scan/WedgeListener';
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

const RAIL: NavItem[] = [
  { key: 'home', to: '/', icon: House },
  { key: 'money', to: '/money', icon: Wallet },
  { key: 'pantry', to: '/pantry', icon: ShoppingBasket },
  { key: 'things', to: '/things', icon: Package },
  { key: 'places', to: '/places', icon: MapPin },
  { key: 'insights', to: '/insights', icon: ChartNoAxesColumn },
  { key: 'settings', to: '/settings', icon: Settings },
];

/** ⌘K / Ctrl+K, /, N, S, G then a letter, ? (MASTER_PLAN §5.4). Letters are ignored while typing. */
function useShortcuts(onPalette: () => void, onHelp: () => void) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const read = createShortcutReader();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (document.querySelector('dialog[open]') && !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return;
      const action = read({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, typing: isTypingTarget(e.target) });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'palette':
          onPalette();
          break;
        case 'help':
          onHelp();
          break;
        case 'scan':
          void navigate({ to: '/scan' });
          break;
        case 'go':
          void navigate({ to: action.to });
          break;
        case 'new': {
          const target = newTargetFor(pathname);
          if (target) void navigate(target as never);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, pathname, onPalette, onHelp]);
}

/** Attention count for the bell (the same feed as Home and /attention). */
function useAttentionCount(householdId: string): number {
  const feed = useQuery({ ...attentionQuery(householdId), refetchOnWindowFocus: true });
  return knownItems(feed.data ?? []).length;
}

function Bell({ count, className }: { count: number; className: string }) {
  const { t } = useTranslation();
  return (
    <Link to="/attention" aria-label={count ? t('shell.attentionCount', { count }) : t('shell.notifications')} className={`relative ${className}`}>
      <BellIcon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
      {count > 0 && (
        <span className="tabular absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red px-1 text-[11px] font-semibold text-[#1a0508]">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

export function AppShell({ membership, children }: { membership: Membership; children: ReactNode }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const openHelp = useCallback(() => setHelp(true), []);
  useShortcuts(openPalette, openHelp);
  const attention = useAttentionCount(membership.household.id);
  const { timezone, locale } = membership.household;
  const city = timezone.split('/').pop()?.replace(/_/g, ' ') ?? '';

  const who = membership.displayName ?? membership.email;
  const roleLine = t('shell.roleLine', {
    role: t(`shell.roles.${membership.role}`),
    household: membership.household.name,
  });

  return (
    <div className="relative z-10 min-h-dvh lg:flex">
      <WedgeListener />
      <CommandPalette open={palette} onClose={() => setPalette(false)} householdId={membership.household.id} locale={locale} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
      {/* Desktop / iPad landscape: glass rail */}
      <aside className="glass-strong hidden border-y-0 border-l-0 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[248px] lg:shrink-0 lg:flex-col lg:gap-7 lg:px-[18px] lg:py-7">
        <div className="px-1.5">
          <Brand />
        </div>
        <nav aria-label={t('nav.main')} className="flex flex-1 flex-col gap-1">
          {RAIL.map((item) => (
            <Link
              key={item.key}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              className="flex h-11 items-center gap-3 rounded-xl px-3.5 text-[15px] font-medium text-muted transition-colors hover:text-text data-[status=active]:accent-pill data-[status=active]:text-text"
            >
              <item.icon className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden />
              {t(`nav.${item.key}`)}
            </Link>
          ))}
        </nav>
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white/[0.03] p-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#f5b83d] to-[#f97316] text-[13px] font-bold text-[#1a1200]">
              {initials(membership.displayName, membership.email)}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold">{who}</div>
              <div className="truncate text-xs text-muted">{roleLine}</div>
            </div>
          </div>
        </div>
        <VersionBadge className="-mt-3 px-1.5" />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        {/* Phone / iPad portrait: header */}
        <header className="pt-safe sticky top-0 z-20 border-b border-line bg-[rgba(5,7,15,0.7)] backdrop-blur-xl lg:hidden">
          <div className="flex h-16 items-center gap-2 px-4">
            <div className="flex flex-1 items-center gap-3">
              <LogoMark size={36} />
              <div className="leading-tight">
                <div className="font-display text-[18px] font-bold">{t('app.name')}</div>
                <div className="text-[11px] text-muted">{t('app.subtitle')}</div>
              </div>
              <EnvChip />
            </div>
            <button
              type="button"
              aria-label={t('shell.searchShort')}
              onClick={openPalette}
              className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-line-2 bg-white/5"
            >
              <Search className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden />
            </button>
            <Bell count={attention} className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-line-2 bg-white/5" />
            <Link
              to="/settings"
              aria-label={t('nav.settings')}
              className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-line-2 bg-white/5"
            >
              <Settings className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
        </header>

        {/* Desktop: top bar */}
        <div className="hidden items-center gap-3 px-9 pt-7 lg:flex">
          <span className="flex-1 text-sm text-muted">
            {longDate(timezone, locale)} · {city}
          </span>
          <button
            type="button"
            onClick={openPalette}
            className="glass flex h-[46px] w-[330px] items-center gap-2.5 rounded-[14px] px-3.5 text-left text-sm text-muted"
          >
            <Search className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
            <span className="flex-1">{t('shell.search')}</span>
            <kbd className="tabular rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-[#adb5d3]">⌘K</kbd>
          </button>
          <Bell count={attention} className="glass flex h-[46px] w-[46px] items-center justify-center rounded-[14px]" />
          <Link
            to="/scan"
            className="glow-gold flex h-[46px] items-center gap-2.5 rounded-[14px] px-5 text-[15px] font-semibold hover:brightness-105"
          >
            <ScanLine className="h-[19px] w-[19px]" strokeWidth={2} aria-hidden />
            {t('nav.scan')}
          </Link>
        </div>

        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pt-5 pb-[calc(var(--nav-h)+env(safe-area-inset-bottom)+2.5rem)] lg:px-9 lg:pt-6 lg:pb-10">
          <div key={pathname} className="page-enter">
            {children}
          </div>
          <footer className="mt-10 text-center lg:hidden">
            <VersionBadge />
          </footer>
        </main>

        {/* Phone / iPad portrait: floating glass dock */}
        <nav
          aria-label={t('nav.main')}
          className="glass-strong pb-safe fixed inset-x-3.5 bottom-3.5 z-30 rounded-3xl shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] lg:hidden"
        >
          <ul className="mx-auto grid h-[var(--nav-h)] max-w-xl grid-cols-5 items-center">
            {TABS.map((item) => (
              <li key={item.key} className="flex justify-center">
                {item.key === 'scan' ? (
                  <Link
                    to={item.to}
                    aria-label={t('nav.scan')}
                    className="-mt-8 flex h-[62px] w-[62px] items-center justify-center rounded-full text-[#1a1200] shadow-[0_0_0_6px_rgba(5,7,15,0.92),0_14px_36px_-8px_rgba(245,184,61,0.95)]"
                    style={{ background: 'radial-gradient(circle at 35% 30%, #ffd980, #f5b83d 60%, #d9971f)' }}
                  >
                    <item.icon className="h-[26px] w-[26px]" strokeWidth={2.1} aria-hidden />
                  </Link>
                ) : (
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.to === '/' }}
                    className="group flex flex-col items-center gap-1 text-[11px] text-muted data-[status=active]:text-text"
                  >
                    <item.icon className="h-[22px] w-[22px]" strokeWidth={1.8} aria-hidden />
                    {t(`nav.${item.key}`)}
                    <span className="h-1 w-1 rounded-full group-data-[status=active]:bg-accent-b group-data-[status=active]:shadow-[0_0_8px_var(--accent-b)]" />
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
