// Quick spend (Phase 12): the calmest, fastest screen in Gedara. Amount first on a big pad, then ONE
// tap on a tile saves it: paid from the person's cash wallet, now, by whoever is signed in. It
// shows as saved at once; with no signal (or an expired login) the entry waits on the phone and is
// sent later, counted once. Gold is only the amount and the "saved" tick: the tiles are the action.
import { Link } from '@tanstack/react-router';
import { Check, CloudOff, Delete, Ellipsis, House, LogIn, Pencil, Smartphone, TriangleAlert, Wallet } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { formatLKR } from '@/lib/money/format';
import { outbox, type SpendOp } from '@/lib/offline';
import { buildSpend, localStamp } from '@/lib/quick/entry';
import { HARD_STOP, favourites, guard, learnedAmount, padPress, rankTiles, type PadKey, type Use } from '@/lib/quick/rank';
import { markReady, markSaved, type Entry, type Snapshot, type Tile } from '@/lib/quick/state';
import { hourIn, todayIn } from '@/lib/time';
import { UNDO_MS } from '@/lib/undo';
import { cn } from '@/lib/utils';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { CashCheck } from './CashCheck';
import { useQuick, type Identity } from './useQuick';

const TileEditor = lazy(() => import('./TileEditor'));
const FixEntry = lazy(() => import('./FixEntry'));
const InstallHelp = lazy(() => import('./InstallHelp'));

const STARTER_KEYS = [
  'tuk', 'bus', 'tea', 'short_eats', 'meal', 'petrol', 'vendor', 'parking', 'other', 'train', 'water', 'pharmacy', 'donation', 'gave',
] as const;
type StarterKey = (typeof STARTER_KEYS)[number];
const isStarter = (k: string | null): k is StarterKey => (STARTER_KEYS as readonly string[]).includes(k ?? '');

/** A tile's name: the person's own, else the translated starter name. */
export function useTileName() {
  const { t } = useTranslation();
  return (tile: Pick<Tile, 'key' | 'label'>) => tile.label ?? (isStarter(tile.key) ? t(`quick.tiles.${tile.key}`) : (tile.key ?? '?'));
}

const PAD: PadKey[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', '00'],
];
const GRID_MAX = 8;
const ASK_MS = 4000;

type Row =
  | { key: string; at: string; name: string; amount: number; kind: 'expense' | 'handover'; status: 'saved'; entry: Entry }
  | { key: string; at: string; name: string; amount: number; kind: 'expense' | 'handover'; status: 'waiting' | 'parked'; op: SpendOp };

function TileButton({
  tile, name, amount, asking, disabled, className, onTap,
}: {
  tile: Tile;
  name: string;
  amount: number;
  asking: boolean;
  disabled: boolean;
  className?: string;
  onTap: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid={`quick-tile-${tile.key ?? tile.id}`}
      disabled={disabled}
      onClick={onTap}
      className={cn(
        'glass flex h-[62px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-center transition-[background-color,transform] active:scale-[0.97] disabled:opacity-50',
        asking ? 'border-caution/60 bg-caution/10' : amount > 0 ? 'hover:bg-white/[0.08]' : 'opacity-80',
        className,
      )}
    >
      {asking ? (
        <>
          <span className="tabular text-[13px] font-semibold text-caution">{formatLKR(amount, { whole: true })}</span>
          <span className="text-[11px] leading-tight text-caution">{t('quick.tapAgain')}</span>
        </>
      ) : (
        <>
          <span className="text-[19px] leading-none" aria-hidden>{tile.icon ?? '•'}</span>
          <span className="w-full truncate text-[12px] leading-tight">{name}</span>
        </>
      )}
    </button>
  );
}


export function QuickScreen({ identity, signedIn, snapshot }: { identity: Identity; signedIn: boolean; snapshot: Snapshot | null }) {
  const { t } = useTranslation();
  const tileName = useTileName();
  const q = useQuick(identity, signedIn, snapshot);
  const { state } = q;
  const canWrite = identity.role !== 'viewer';
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ op: SpendOp } | null>(null);
  const [oneOff, setOneOff] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'menu' | 'more' | 'waiting' | 'account' | 'edit' | 'install' | 'handover'>(null);
  const [pick, setPick] = useState<Row | null>(null);
  const [fixing, setFixing] = useState<Entry | null>(null);
  const [handover, setHandover] = useState<{ tile: Tile; amount: number } | null>(null);

  const amount = typed ? Number(typed) : 0;
  const wallet = state.prefs?.cash_account_id ?? null;
  const walletName = state.accounts.find((a) => a.id === wallet)?.name ?? t('quick.cash');
  const payFrom = oneOff ?? wallet;
  const payName = state.accounts.find((a) => a.id === payFrom)?.name ?? walletName;

  // The order is worked out once per open (and when the tiles change), never while the thumb is on its way.
  const uses = useMemo<Use[]>(
    () => state.entries.filter((e) => e.id !== null).map((e) => ({ tile_id: e.tile_id, amount: e.amount, at: e.client_at })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new entry must not reshuffle the tiles under the thumb
    [state.tiles, state.prefs?.order_mode],
  );
  const ranked = useMemo(
    () => rankTiles(state.tiles, uses, new Date(), (d) => hourIn(identity.timezone, d), state.prefs?.order_mode ?? 'learned'),
    [state.tiles, uses, identity.timezone, state.prefs?.order_mode],
  );
  const other = ranked.find((x) => x.key === 'other') ?? null;
  const grid = ranked.filter((x) => x.key !== 'other');
  const favs = useMemo(() => favourites(grid.filter((x) => x.kind === 'expense'), uses), [grid, uses]);

  // Speed: how long until the pad could be used (Diagnostics shows the last real figure).
  useEffect(() => {
    if (state.tiles.length > 0) markReady();
  }, [state.tiles.length]);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), UNDO_MS);
    return () => window.clearTimeout(id);
  }, [saved]);
  useEffect(() => {
    if (!asking) return;
    const id = window.setTimeout(() => setAsking(null), ASK_MS);
    return () => window.clearTimeout(id);
  }, [asking]);

  function save(tile: Tile, value: number, toAccount: string | null = null) {
    if (!canWrite) return;
    const account = payFrom ?? identity.householdId; // no wallet known yet (first open offline): the database uses the person's own
    const op = buildSpend({
      householdId: identity.householdId, userId: identity.userId, timeZone: identity.timezone,
      entry: tile.kind, tileId: tile.id, name: tileName(tile), categoryId: tile.category_id, amount: value,
      accountId: account, explicitAccount: oneOff !== null && oneOff !== wallet, toAccountId: toAccount,
    });
    setTyped('');
    setAsking(null);
    setOneOff(null);
    setSaved({ op });
    markSaved();
    navigator.vibrate?.(12);
    void q.add(op).then(() => {
      // Never dropped: an entry the database refused is parked and listed under "waiting".
      if (outbox.list().some((o) => o.op_id === op.op_id && o.state === 'parked')) {
        toast.error(t('quick.refused'), { action: { label: t('quick.waiting.see'), onClick: () => setSheet('waiting') } });
      }
    });
  }

  function tap(tile: Tile, value: number, isFavourite = false) {
    if (!canWrite) return;
    if (!(value > 0)) {
      toast.message(t('quick.typeFirst'));
      return;
    }
    const usual = tile.usual_amount ?? learnedAmount(tile.id, uses);
    const g = guard(value, usual);
    if (g === 'stop') {
      toast.error(t('quick.tooMuch', { max: formatLKR(HARD_STOP, { whole: true }) }));
      return;
    }
    if (g === 'ask' && !isFavourite && asking !== tile.id) {
      setAsking(tile.id);
      return;
    }
    if (tile.kind === 'handover') {
      if (state.wallets.length === 0) {
        toast.message(t('quick.handover.none'));
        return;
      }
      if (state.wallets.length > 1) {
        setHandover({ tile, amount: value });
        setSheet('handover');
        return;
      }
      save(tile, value, state.wallets[0]!.account_id);
      return;
    }
    save(tile, value);
  }

  async function undo(opId: string) {
    setSaved(null);
    try {
      await q.remove(opId);
    } catch {
      toast.error(t('quick.undoFailed'));
    }
  }

  async function retry(op: SpendOp) {
    await outbox.remove(op.op_id);
    await q.add({ ...op, state: 'queued', error: undefined });
  }

  const today = todayIn(identity.timezone);
  const rows = useMemo<Row[]>(() => {
    const waiting: Row[] = q.mine.map((op) => ({
      key: op.op_id, at: op.client_at, name: op.name, amount: op.amount, kind: op.entry,
      status: op.state === 'parked' ? 'parked' : 'waiting', op,
    }));
    const queued = new Set(q.mine.map((o) => o.op_id));
    const sent: Row[] = state.entries
      .filter((e) => e.id !== null && e.occurred_on === today && !queued.has(e.op_id))
      .map((e) => ({ key: e.op_id, at: e.client_at, name: e.label ?? t('quick.title'), amount: e.amount, kind: e.kind, status: 'saved', entry: e }));
    return [...waiting, ...sent].sort((a, b) => b.at.localeCompare(a.at));
  }, [q.mine, state.entries, today, t]);
  const todayTotal = rows.filter((r) => r.kind === 'expense' && localStamp(identity.timezone, new Date(r.at)).date === today).reduce((s, r) => s + r.amount, 0);
  const waitingCount = q.mine.length;
  const parkedCount = q.mine.filter((o) => o.state === 'parked').length;
  const left = state.prefs?.hand === 'left';

  const tileButton = (tile: Tile, extra?: string) => (
    <TileButton
      key={tile.id}
      tile={tile}
      name={tileName(tile)}
      amount={amount}
      asking={asking === tile.id}
      disabled={!canWrite}
      className={extra}
      onTap={() => tap(tile, amount)}
    />
  );

  const entryPanel = (
    <section className="flex flex-col gap-3" aria-label={t('quick.title')}>
      <div className="flex flex-col items-center pt-1">
        <output
          data-testid="quick-amount"
          aria-live="polite"
          className={cn('tabular font-mono text-[46px] leading-none font-semibold tracking-tight', amount > 0 ? 'text-gold' : 'text-faint')}
        >
          {formatLKR(amount, { whole: true })}
        </output>
        <button
          type="button"
          onClick={() => setSheet('account')}
          className="mt-2 flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-muted hover:bg-white/5"
        >
          <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {/* "Cash — Didula · now", not "Cash — Didula · Didula · now" */}
            {identity.name && !payName.includes(identity.name)
              ? t('quick.from', { account: payName, who: identity.name })
              : t('quick.fromShort', { account: payName })}
          </span>
        </button>
      </div>

      {favs.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-0.5" data-testid="quick-favourites">
          {favs.map((f) => (
            <button
              key={f.tile.id}
              type="button"
              disabled={!canWrite}
              data-testid={`quick-fav-${f.tile.key ?? f.tile.id}`}
              onClick={() => tap(f.tile, f.amount, true)}
              className="accent-pill flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] active:scale-[0.97] disabled:opacity-50"
            >
              <span aria-hidden>{f.tile.icon}</span>
              <span>{tileName(f.tile)}</span>
              <span className="tabular font-mono font-semibold">{f.amount.toLocaleString('en-LK')}</span>
            </button>
          ))}
        </div>
      )}

      {state.tiles.length === 0 ? (
        <div className="grid grid-cols-4 gap-2" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="glass h-[62px] rounded-2xl opacity-40" />)}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2" data-testid="quick-tiles">{grid.slice(0, GRID_MAX).map((x) => tileButton(x))}</div>
      )}

      <div className={cn('flex gap-2', left && 'flex-row-reverse')}>
        <div className="grid flex-1 grid-cols-3 gap-2">
          {PAD.flat().map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`quick-pad-${k}`}
              aria-label={k === 'clear' ? t('quick.clear') : k}
              onClick={() => {
                setAsking(null);
                setTyped((cur) => padPress(cur, k));
              }}
              className="glass tabular h-[54px] rounded-2xl font-mono text-[22px] font-medium active:scale-[0.97] active:bg-white/10"
            >
              {k === 'clear' ? 'C' : k}
            </button>
          ))}
        </div>
        <div className="grid w-[23%] grid-rows-4 gap-2">
          <button
            type="button"
            data-testid="quick-pad-back"
            aria-label={t('quick.back')}
            onClick={() => setTyped((cur) => padPress(cur, 'back'))}
            className="glass flex h-[54px] items-center justify-center rounded-2xl active:bg-white/10"
          >
            <Delete className="h-5 w-5" aria-hidden />
          </button>
          {other ? tileButton(other, 'h-[54px]') : <span />}
          <button
            type="button"
            onClick={() => setSheet('more')}
            disabled={grid.length <= GRID_MAX}
            className="glass flex h-[54px] flex-col items-center justify-center rounded-2xl text-[11.5px] text-muted disabled:opacity-30"
          >
            {t('quick.more')}
          </button>
          <button
            type="button"
            data-testid="quick-menu"
            aria-label={t('quick.menu.title')}
            onClick={() => setSheet('menu')}
            className="glass flex h-[54px] items-center justify-center rounded-2xl text-muted"
          >
            <Ellipsis className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );

  const dayPanel = (
    <section className="flex flex-col gap-3">
      {saved && (
        <div role="status" data-testid="quick-saved" className="slide-up flex items-center gap-3 rounded-2xl border border-gold/40 bg-gold-soft px-3.5 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold text-[#1a1200]">
            <Check className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">
              {t('quick.saved')} · {saved.op.name} <span className="tabular font-mono">{formatLKR(saved.op.amount, { whole: true })}</span>
            </div>
            {/* only once it is really held back (no signal, no login), not while it is on its way */}
            {q.mine.some((o) => o.op_id === saved.op.op_id && (!o.immediate || !signedIn)) && (
              <div className="flex items-center gap-1 text-[12px] text-muted">
                <CloudOff className="h-3.5 w-3.5" aria-hidden />
                {t('quick.keptOnPhone')}
              </div>
            )}
          </div>
          <Button size="sm" data-testid="quick-undo" onClick={() => void undo(saved.op.op_id)}>
            {t('common.undo')}
          </Button>
        </div>
      )}

      <div className="glass rounded-[var(--r)] p-4" data-testid="quick-today">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 font-display text-[15px] font-semibold">{t('quick.today')}</h2>
          <span className="tabular font-mono text-[14px] text-muted">{formatLKR(todayTotal, { whole: true })}</span>
        </div>
        {rows.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">{t('quick.todayEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {rows.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => setPick(r)}
                  className="flex w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left hover:bg-white/[0.04]"
                >
                  <span className="tabular w-11 shrink-0 font-mono text-[12.5px] text-muted">{localStamp(identity.timezone, new Date(r.at)).time.slice(0, 5)}</span>
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">{r.name}</span>
                  {r.status === 'waiting' && <CloudOff className="h-4 w-4 shrink-0 text-accent-b" aria-label={t('quick.waiting.one')} />}
                  {r.status === 'parked' && <TriangleAlert className="h-4 w-4 shrink-0 text-caution" aria-label={t('quick.waiting.parked')} />}
                  <span className="tabular font-mono text-[14.5px]">{r.amount.toLocaleString('en-LK')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {signedIn && canWrite && waitingCount === 0 && (
        <CashCheck identity={identity} state={state} online={q.online} walletName={walletName} onDone={q.patch} onRefresh={q.refresh} />
      )}
      <p className="tabular text-center text-[10.5px] text-faint" data-testid="quick-version">v{APP_VERSION} · {GIT_SHA}</p>
    </section>
  );

  return (
    <div className="pt-safe pb-safe relative z-10 mx-auto flex min-h-dvh w-full max-w-[460px] flex-col gap-3 px-3.5 lg:max-w-[980px] lg:px-8" data-testid="quick-screen">
      <header className="flex h-12 items-center gap-2">
        <Link to="/" aria-label={t('quick.menu.openGedara')} className={buttonVariants({ variant: 'ghost', size: 'icon' })}>
          <House className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="flex-1 font-display text-[19px] font-semibold tracking-tight">{t('quick.title')}</h1>
        {(waitingCount > 0 || q.others > 0) && (
          <button
            type="button"
            data-testid="quick-waiting"
            onClick={() => setSheet('waiting')}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px]',
              parkedCount > 0 ? 'border-caution/50 text-caution' : 'border-line-2 text-accent-b',
            )}
          >
            {parkedCount > 0 ? <TriangleAlert className="h-4 w-4" aria-hidden /> : <CloudOff className="h-4 w-4" aria-hidden />}
            <span className="tabular">{t('quick.waiting.count', { count: waitingCount + q.others })}</span>
          </button>
        )}
      </header>

      {!signedIn && (
        <div role="status" data-testid="quick-signin" className="flex items-center gap-3 rounded-2xl border border-line-2 bg-white/[0.04] px-3.5 py-2.5 text-[13.5px]">
          <LogIn className="h-4 w-4 shrink-0 text-accent-b" aria-hidden />
          <span className="flex-1">{t('quick.signedOut')}</span>
          <Link to="/login" search={{ redirect: '/quick' }} className={buttonVariants({ size: 'sm' })}>
            {t('quick.signIn')}
          </Link>
        </div>
      )}
      {!canWrite && <p className="rounded-2xl bg-white/[0.04] px-3.5 py-2.5 text-[13.5px] text-muted">{t('quick.viewer')}</p>}
      {signedIn && q.error && state.tiles.length === 0 && (
        <p className="rounded-2xl bg-white/[0.04] px-3.5 py-2.5 text-[13.5px] text-muted">{t('quick.loadError')}</p>
      )}

      {/* iPad: the pad on the side of the hand that holds it, the day on the other. */}
      <div className={cn('flex flex-col gap-4 lg:grid lg:flex-1 lg:gap-10', left ? 'lg:grid-cols-[420px_1fr]' : 'lg:grid-cols-[1fr_420px]')}>
        {/* the pad at the bottom of the screen (thumb reach), the day at the top */}
        <div className={cn('lg:self-end lg:pb-8', !left && 'lg:order-2')}>{entryPanel}</div>
        <div className="lg:self-start">{dayPanel}</div>
      </div>

      {/* ── Sheets ─────────────────────────────────────────────────────────── */}
      <Sheet open={sheet === 'more'} onClose={() => setSheet(null)} title={t('quick.more')}>
        <div className="grid grid-cols-4 gap-2">{grid.slice(GRID_MAX).map((x) => tileButton(x))}</div>
      </Sheet>

      <Sheet open={sheet === 'account'} onClose={() => setSheet(null)} title={t('quick.account.title')}>
        <p className="mb-3 text-[13px] text-muted">{t('quick.account.hint')}</p>
        <ul className="flex flex-col gap-1.5">
          {state.accounts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  setOneOff(a.id === wallet ? null : a.id);
                  setSheet(null);
                }}
                className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] hover:bg-white/5', a.id === payFrom && 'bg-white/[0.06]')}
              >
                <span className="flex-1 truncate">{a.name}</span>
                {a.id === wallet && <span className="text-[12px] text-muted">{t('quick.account.mine')}</span>}
                {a.id === payFrom && <Check className="h-4 w-4 text-teal" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      <Sheet open={sheet === 'handover'} onClose={() => setSheet(null)} title={t('quick.handover.title')}>
        <ul className="flex flex-col gap-1.5">
          {state.wallets.map((w) => (
            <li key={w.account_id}>
              <button
                type="button"
                className="flex w-full items-center rounded-xl px-3 py-3 text-left text-[15px] hover:bg-white/5"
                onClick={() => {
                  setSheet(null);
                  if (handover) save(handover.tile, handover.amount, w.account_id);
                }}
              >
                {w.person ?? w.name}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      <Sheet open={sheet === 'waiting'} onClose={() => setSheet(null)} title={t('quick.waiting.title')}>
        <p className="mb-3 text-[13px] text-muted" data-testid="quick-waiting-why">
          {!signedIn ? t('quick.waiting.whySignIn') : !q.online ? t('quick.waiting.whyOffline') : t('quick.waiting.whyRetry')}
        </p>
        <ul className="flex flex-col gap-2">
          {q.mine.map((op) => (
            <li key={op.op_id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px]">
                  {op.name} <span className="tabular font-mono">{formatLKR(op.amount, { whole: true })}</span>
                </div>
                <div className={cn('text-[12px]', op.state === 'parked' ? 'text-caution' : 'text-muted')}>
                  {op.state === 'parked'
                    ? t('quick.waiting.refusedWhy', { why: op.error?.code === '42501' ? t('quick.waiting.notAllowed') : (op.error?.message ?? '') })
                    : new Date(op.client_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
              {op.state === 'parked' && (
                <Button size="sm" onClick={() => void retry(op)}>
                  {t('quick.waiting.retry')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void q.remove(op.op_id)}>
                {t('quick.delete')}
              </Button>
            </li>
          ))}
        </ul>
        {q.others > 0 && <p className="mt-3 text-[12.5px] text-muted">{t('quick.waiting.others', { count: q.others })}</p>}
        {signedIn && q.online && q.mine.some((o) => o.state === 'queued') && (
          <Button className="mt-4 w-full" onClick={() => void outbox.flush()}>
            {t('quick.waiting.sendNow')}
          </Button>
        )}
      </Sheet>

      <Sheet open={pick !== null} onClose={() => setPick(null)} title={pick ? `${pick.name} · ${formatLKR(pick.amount, { whole: true })}` : ''}>
        {pick && (
          <div className="flex flex-col gap-2.5">
            {pick.status === 'saved' ? (
              <>
                {pick.entry.notes && <p className="text-[13.5px] text-muted">{pick.entry.notes}</p>}
                <Button
                  disabled={!signedIn || !q.online}
                  onClick={() => {
                    setFixing(pick.entry);
                    setPick(null);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t('quick.fix')}
                </Button>
              </>
            ) : (
              <p className="text-[13.5px] text-muted">{t('quick.fixLater')}</p>
            )}
            <Button
              variant="destructive"
              disabled={pick.status === 'saved' && (!signedIn || !q.online)}
              onClick={() => {
                const key = pick.key;
                setPick(null);
                void undo(key);
              }}
            >
              {t('quick.delete')}
            </Button>
          </div>
        )}
      </Sheet>

      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title={t('quick.menu.title')}>
        <div className="flex flex-col gap-2.5">
          <Button disabled={!signedIn || !q.online || !canWrite} data-testid="quick-edit-tiles" onClick={() => setSheet('edit')}>
            <Pencil className="h-4 w-4" aria-hidden />
            {t('quick.menu.edit')}
          </Button>
          <Button data-testid="quick-install" onClick={() => setSheet('install')}>
            <Smartphone className="h-4 w-4" aria-hidden />
            {t('quick.menu.install')}
          </Button>
          <Link to="/money" className={buttonVariants({ variant: 'ghost' })}>
            {t('quick.menu.openMoney')}
          </Link>
          {state.balance !== null && (
            <p className="text-center text-[13px] text-muted">
              {walletName}: <span className="tabular font-mono">{formatLKR(state.balance)}</span>
            </p>
          )}
        </div>
      </Sheet>

      <Suspense fallback={null}>
        {sheet === 'edit' && <TileEditor identity={identity} state={state} onClose={() => setSheet(null)} onChanged={q.refresh} />}
        {sheet === 'install' && <InstallHelp onClose={() => setSheet(null)} />}
        {fixing && (
          <FixEntry
            identity={identity}
            entry={fixing}
            onClose={() => {
              setFixing(null);
              void q.refresh();
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
