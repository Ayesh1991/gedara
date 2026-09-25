import { useQueryClient } from '@tanstack/react-query';
import { ScanLine, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AccountSelect, CategorySelect, Money } from '@/components/money/bits';
import { CameraScanner } from '@/components/scan/CameraScanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { findSub, type CategoryRow } from '@/lib/money/categoriesMap';
import { lineFingerprint, manualFingerprint } from '@/lib/money/fingerprint';
import { parseAmount } from '@/lib/money/format';
import { lastAccount, pickableAccounts, rememberAccount, type Account } from '@/lib/money/queries';
import type { Place } from '@/lib/places';
import { resolveScan } from '@/lib/resolve';
import {
  invalidateThings,
  moveAssets,
  sellAsset,
  thingsErrorKey,
  unsellAsset,
  updateAsset,
  type Asset,
} from '@/lib/things/queries';
import { todayIn } from '@/lib/time';
import type { Tree } from '@/lib/tree';
import { UNDO_MS } from '@/lib/undo';
import { fieldLabel } from './bits';

/** Sell (§4 row 6): the income goes to the ledger and the thing is marked sold; Undo takes both back. */
export function SellSheet({
  open,
  onClose,
  householdId,
  timezone,
  asset,
  accounts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  asset: Asset;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t('things.sell.title', { name: asset.name })}>
      {open && <SellBody onClose={onClose} householdId={householdId} timezone={timezone} asset={asset} accounts={accounts} categories={categories} />}
    </Sheet>
  );
}

function SellBody({
  onClose,
  householdId,
  timezone,
  asset,
  accounts,
  categories,
}: {
  onClose: () => void;
  householdId: string;
  timezone: string;
  asset: Asset;
  accounts: Account[];
  categories: CategoryRow[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const today = todayIn(timezone);
  const pickable = pickableAccounts(accounts);
  const [price, setPrice] = useState('');
  const [soldOn, setSoldOn] = useState(today);
  const [soldTo, setSoldTo] = useState('');
  const [accountId, setAccountId] = useState<string | null>(() => {
    const last = lastAccount();
    return (pickable.find((a) => a.kind === 'cash') ?? pickable.find((a) => a.id === last) ?? pickable[0])?.id ?? null;
  });
  const [categoryId, setCategoryId] = useState<string | null>(
    findSub(categories, 'income', 'Sale of belongings')?.id ?? findSub(categories, 'income', 'Other income')?.id ?? null,
  );
  const [withParts, setWithParts] = useState(asset.parts > 0);
  const [busy, setBusy] = useState(false);
  const value = price.trim() ? parseAmount(price) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !value || value <= 0 || !accountId || !categoryId) return;
    setBusy(true);
    const payee = soldTo.trim() || null;
    const fp = manualFingerprint({ type: 'income', date: soldOn, accountId, payee, total: value });
    try {
      await sellAsset({
        asset_id: asset.id,
        sold_on: soldOn,
        sold_to: payee,
        price: value,
        account_id: accountId,
        category_id: categoryId,
        fingerprint: fp,
        line_fingerprint: lineFingerprint(fp, 0, `Sold: ${asset.name}`.slice(0, 200), value),
        include_parts: withParts,
      });
      rememberAccount(accountId);
      await invalidateThings(qc, householdId);
      toast.success(t('things.sell.done', { name: asset.name }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            unsellAsset(asset.id)
              .then(() => invalidateThings(qc, householdId))
              .then(() => toast(t('things.sell.undone')))
              .catch((err: unknown) => toast.error(t(`things.errors.${thingsErrorKey(err)}`)));
          },
        },
      });
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function gaveAway() {
    setBusy(true);
    try {
      await updateAsset(asset.id, { status: 'disposed' });
      await invalidateThings(qc, householdId);
      toast.success(t('things.sell.disposed', { name: asset.name }), {
        duration: UNDO_MS,
        action: {
          label: t('common.undo'),
          onClick: () => {
            updateAsset(asset.id, { status: asset.status })
              .then(() => invalidateThings(qc, householdId))
              .catch((err: unknown) => toast.error(t(`things.errors.${thingsErrorKey(err)}`)));
          },
        },
      });
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="sell-form">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="sell-price" className={fieldLabel}>
            {t('things.sell.price')}
          </label>
          <Input id="sell-price" inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} className="tabular" autoFocus />
        </div>
        <div>
          <label htmlFor="sell-date" className={fieldLabel}>
            {t('things.sell.date')}
          </label>
          <Input id="sell-date" type="date" value={soldOn} max={today} onChange={(e) => setSoldOn(e.target.value)} className="tabular" />
        </div>
      </div>
      <div>
        <label htmlFor="sell-to" className={fieldLabel}>
          {t('things.sell.to')}
        </label>
        <Input id="sell-to" value={soldTo} maxLength={120} onChange={(e) => setSoldTo(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="sell-account" className={fieldLabel}>
            {t('things.sell.account')}
          </label>
          <AccountSelect id="sell-account" accounts={pickable} value={accountId} onChange={setAccountId} />
        </div>
        <div>
          <label htmlFor="sell-category" className={fieldLabel}>
            {t('things.sell.category')}
          </label>
          <CategorySelect id="sell-category" categories={categories} value={categoryId} onChange={setCategoryId} kind="income" />
        </div>
      </div>
      {asset.parts > 0 && (
        <label className="flex items-center gap-2.5 text-[14px]">
          <input type="checkbox" checked={withParts} onChange={(e) => setWithParts(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
          {t('things.sell.withParts', { count: asset.parts })}
        </label>
      )}
      {asset.book_value !== null && value !== null && value > 0 && (
        <p className="text-[13px] text-muted">
          {t('things.sell.vsBook')} <Money value={asset.book_value} /> ·{' '}
          <Money value={value - asset.book_value} tone plus className={value - asset.book_value < 0 ? 'text-caution' : undefined} />
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || !value || value <= 0 || !accountId || !categoryId} className="w-full">
        {busy ? t('common.saving') : t('things.sell.confirm')}
      </Button>
      <Button onClick={() => void gaveAway()} disabled={busy}>
        {t('things.sell.gaveAway')}
      </Button>
    </form>
  );
}

/** Lend to someone (status lent); returning is one tap on the thing's page. */
export function LendSheet({
  open,
  onClose,
  householdId,
  timezone,
  asset,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  asset: Asset;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [on, setOn] = useState(todayIn(timezone));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!to.trim() || busy) return;
    setBusy(true);
    try {
      await updateAsset(asset.id, { status: 'lent', lent_to: to.trim(), lent_on: on });
      await invalidateThings(qc, householdId);
      toast.success(t('things.lend.done', { name: asset.name, to: to.trim() }));
      setTo('');
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('things.lend.title', { name: asset.name })}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="lend-to" className={fieldLabel}>
            {t('things.lend.to')}
          </label>
          <Input id="lend-to" value={to} maxLength={80} required autoFocus onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="lend-on" className={fieldLabel}>
            {t('things.lend.on')}
          </label>
          <Input id="lend-on" type="date" value={on} onChange={(e) => setOn(e.target.value)} className="tabular" />
        </div>
        <Button type="submit" variant="primary" disabled={busy || !to.trim()} className="w-full">
          {t('things.lend.confirm')}
        </Button>
      </form>
    </Sheet>
  );
}

/** Put a thing somewhere: pick the place, or scan its label. Parts can come along. */
export function AssetMoveSheet({
  open,
  onClose,
  householdId,
  asset,
  partIds,
  tree,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  asset: Asset;
  partIds: string[];
  tree: Tree<Place>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [withParts, setWithParts] = useState(true);
  const [busy, setBusy] = useState(false);

  const targets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...tree.byId.values()]
      .filter((p) => p.id !== asset.location_id && (!needle || p.path.toLowerCase().includes(needle)))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  }, [tree, asset.location_id, q]);

  async function moveTo(place: Place | null) {
    if (busy) return;
    setBusy(true);
    try {
      await moveAssets(withParts ? [asset.id, ...partIds] : [asset.id], place?.id ?? null);
      await invalidateThings(qc, householdId);
      toast.success(t('things.move.done', { name: asset.name, place: place?.path ?? t('things.noPlace') }));
      onClose();
    } catch (err) {
      toast.error(t(`things.errors.${thingsErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function onScan(text: string) {
    const r = await resolveScan(text).catch(() => null);
    if (r?.status !== 'place') {
      toast.error(t('places.moveScanNotPlace'));
      return;
    }
    setScanning(false);
    const place = tree.byId.get(r.place.id) ?? null;
    await moveTo(place);
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('things.move.title', { name: asset.name })}>
      <div className="flex flex-col gap-3">
        {partIds.length > 0 && (
          <label className="flex items-center gap-2.5 text-[14px]">
            <input type="checkbox" checked={withParts} onChange={(e) => setWithParts(e.target.checked)} className="h-5 w-5 accent-[var(--accent-a)]" />
            {t('things.move.withParts', { count: partIds.length })}
          </label>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input aria-label={t('things.move.search')} placeholder={t('things.move.search')} value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
          </div>
          <Button size="icon" aria-label={t('things.move.scan')} onClick={() => setScanning((s) => !s)}>
            <ScanLine className="h-[18px] w-[18px]" aria-hidden />
          </Button>
        </div>
        {scanning && <CameraScanner onDetect={(text) => void onScan(text)} autoStart compact className="aspect-square w-full" />}
        <ul className="flex max-h-[45dvh] flex-col gap-1 overflow-y-auto">
          {asset.location_id && (
            <li>
              <button type="button" disabled={busy} onClick={() => void moveTo(null)} className="w-full rounded-xl px-3 py-3 text-left text-[14.5px] text-muted hover:bg-white/5">
                {t('things.move.nowhere')}
              </button>
            </li>
          )}
          {targets.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={busy} onClick={() => void moveTo(p)} className="w-full rounded-xl px-3 py-3 text-left text-[14.5px] hover:bg-white/5">
                {p.path}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
