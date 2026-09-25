import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  BellRing,
  ChartNoAxesColumn,
  FolderTree,
  House,
  MapPin,
  Package,
  PackagePlus,
  Plus,
  Receipt,
  ScanLine,
  Search,
  Settings,
  ShoppingBasket,
  Tag,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Target } from '@/lib/attention';
import { formatLKR } from '@/lib/money/format';
import { categoriesQuery } from '@/lib/money/queries';
import { supabase } from '@/lib/supabase';
import { formatDay } from '@/lib/time';
import { cn } from '@/lib/utils';

interface Hit {
  type: 'product' | 'asset' | 'location' | 'transaction' | 'line' | 'category';
  id: string;
  ref_id: string;
  title: string;
  subtitle: string | null;
  occurred_on: string | null;
  amount: number | null;
}

interface Entry {
  key: string;
  icon: LucideIcon;
  title: string;
  sub?: string;
  target: Target;
}

const TYPE_ICON: Record<Hit['type'], LucideIcon> = {
  product: ShoppingBasket,
  asset: Package,
  location: MapPin,
  transaction: Receipt,
  line: Receipt,
  category: FolderTree,
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** ⌘K: search every product, thing, place, bill and bill line, plus quick commands (MASTER_PLAN §5.4). */
export function CommandPalette({ open, onClose, householdId, locale }: { open: boolean; onClose: () => void; householdId: string; locale: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 180);
  const categories = useQuery({ ...categoriesQuery(householdId), enabled: open });
  const hits = useQuery({
    queryKey: ['search', householdId, dq],
    queryFn: async (): Promise<Hit[]> => {
      const { data, error } = await supabase.rpc('search_all', { p_household: householdId, p_q: dq, p_limit: 20 });
      if (error) throw error;
      return (data ?? []) as unknown as Hit[];
    },
    enabled: open && dq.length >= 2,
    staleTime: 10_000,
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const commands: Entry[] = useMemo(
    () => [
      { key: 'c-home', icon: House, title: t('palette.go', { place: t('nav.home') }), target: { to: '/' } },
      { key: 'c-attention', icon: BellRing, title: t('palette.go', { place: t('attention.title') }), target: { to: '/attention' } },
      { key: 'c-money', icon: Wallet, title: t('palette.go', { place: t('nav.money') }), target: { to: '/money' } },
      { key: 'c-pantry', icon: ShoppingBasket, title: t('palette.go', { place: t('nav.pantry') }), target: { to: '/pantry' } },
      { key: 'c-things', icon: Package, title: t('palette.go', { place: t('nav.things') }), target: { to: '/things' } },
      { key: 'c-places', icon: MapPin, title: t('palette.go', { place: t('nav.places') }), target: { to: '/places' } },
      { key: 'c-insights', icon: ChartNoAxesColumn, title: t('palette.go', { place: t('nav.insights') }), target: { to: '/insights' } },
      { key: 'c-settings', icon: Settings, title: t('palette.go', { place: t('nav.settings') }), target: { to: '/settings' } },
      { key: 'c-expense', icon: Plus, title: t('palette.newExpense'), target: { to: '/money', search: { add: 'expense' } } },
      { key: 'c-product', icon: PackagePlus, title: t('palette.newProduct'), target: { to: '/pantry', search: { new: '1' } } },
      { key: 'c-thing', icon: Tag, title: t('palette.newThing'), target: { to: '/things', search: { new: '1' } } },
      { key: 'c-scan', icon: ScanLine, title: t('palette.scan'), target: { to: '/scan' } },
    ],
    [t],
  );

  const entries: Entry[] = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const cmds = commands.filter((c) => !ql || c.title.toLowerCase().includes(ql));
    const cats = categories.data ?? [];
    const found = (dq.length >= 2 ? (hits.data ?? []) : []).map((h): Entry => {
      const date = h.occurred_on ? formatDay(h.occurred_on, locale) : null;
      const money = h.amount !== null ? formatLKR(Number(h.amount), { whole: true }) : null;
      let target: Target;
      switch (h.type) {
        case 'product':
          target = { to: '/pantry/$productId', params: { productId: h.id } };
          break;
        case 'asset':
          target = { to: '/things/$assetId', params: { assetId: h.id } };
          break;
        case 'location':
          target = { to: '/places/$placeId', params: { placeId: h.id } };
          break;
        case 'transaction':
          target = { to: '/money/tx/$txId', params: { txId: h.id } };
          break;
        case 'line':
          target = { to: '/money/tx/$txId', params: { txId: h.ref_id }, search: { line: h.id } };
          break;
        case 'category': {
          const parent = cats.find((c) => c.id === h.id)?.parent_id;
          target = { to: '/insights/$area', params: { area: 'spend' }, search: parent ? { cat: parent, sub: h.id } : { cat: h.id } };
          break;
        }
      }
      return {
        key: `${h.type}-${h.id}`,
        icon: TYPE_ICON[h.type],
        title: h.title,
        sub: [t(`palette.types.${h.type}`), h.subtitle, date, money].filter(Boolean).join(' · '),
        target,
      };
    });
    return [...found, ...cmds];
  }, [q, dq, hits.data, commands, categories.data, locale, t]);

  function go(e: Entry) {
    onClose();
    void navigate(e.target as never);
  }

  return (
    <dialog
      ref={ref}
      aria-label={t('palette.title')}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mx-auto mt-[8dvh] w-[calc(100%-2rem)] max-w-xl rounded-[24px] border border-line-2 bg-[rgba(9,12,24,0.97)] p-0 text-text shadow-2xl backdrop:bg-black/60"
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="h-5 w-5 shrink-0 text-muted" aria-hidden />
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, entries.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter' && entries[active]) {
                  e.preventDefault();
                  go(entries[active]);
                }
              }}
              placeholder={t('shell.search')}
              aria-label={t('shell.search')}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={entries[active] ? `palette-${entries[active].key}` : undefined}
              className="h-14 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
            />
            <kbd className="tabular hidden rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-[#adb5d3] sm:block">Esc</kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[60dvh] overflow-y-auto p-2">
            {dq.length >= 2 && hits.isFetching && !hits.data && <li className="px-3 py-2 text-[13px] text-muted">{t('palette.searching')}</li>}
            {dq.length >= 2 && hits.data?.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">{t('palette.nothing', { q: dq })}</li>}
            {entries.map((e, i) => (
              <li
                key={e.key}
                id={`palette-${e.key}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(e)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5', i === active && 'bg-white/[0.07]')}
              >
                <e.icon className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px]">{e.title}</span>
                  {e.sub && <span className="block truncate text-[12px] text-muted">{e.sub}</span>}
                </span>
                {i === active && <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </dialog>
  );
}
