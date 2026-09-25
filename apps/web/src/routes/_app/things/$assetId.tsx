import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  CalendarClock,
  ChevronLeft,
  Copy,
  HandCoins,
  Handshake,
  Pencil,
  Printer,
  RotateCcw,
  Split,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Money } from '@/components/money/bits';
import { CodeQr } from '@/components/places/PlaceVisuals';
import { AssetForm } from '@/components/things/AssetForm';
import { AssetTimeline, DueChip, ValueLine } from '@/components/things/AssetViews';
import { DocumentsPanel } from '@/components/things/DocumentsPanel';
import { AssetMoveSheet, LendSheet, SellSheet } from '@/components/things/LifecycleSheets';
import { LogServiceSheet, PlanSheet } from '@/components/things/MaintenanceSheets';
import { AssetArt, IconAction, Section, StatusBadge, WarrantyBadge, useThings } from '@/components/things/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { removeEntityPhoto } from '@/lib/photos';
import { displayValue, fieldsFor } from '@/lib/things/fields';
import {
  activityQuery,
  deleteAsset,
  deleteLog,
  invalidateThings,
  logsQuery,
  plansQuery,
  splitAsset,
  thingsErrorKey,
  thingsKey,
  unsellAsset,
  updateAsset,
  type Asset,
  type MaintenanceLog,
  type Plan,
} from '@/lib/things/queries';
import { assetTag } from '@/lib/things/value';
import { formatDay, todayIn } from '@/lib/time';
import { scheduleUndoableDelete } from '@/lib/undo';

export const Route = createFileRoute('/_app/things/$assetId')({
  component: AssetPage,
});

type SheetName = 'edit' | 'move' | 'lend' | 'sell' | 'log' | 'plan';

function AssetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { assetId } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone, locale } = membership.household;
  const canWrite = membership.role !== 'viewer';
  const today = todayIn(timezone);
  const things = useThings(householdId);
  const plans = useQuery(plansQuery(householdId, assetId));
  const logs = useQuery(logsQuery(householdId, assetId));
  const activity = useQuery(activityQuery(householdId, assetId));
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [planFor, setPlanFor] = useState<Plan | null>(null);
  const [logPlan, setLogPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const assets = useMemo(() => things.assets.data ?? [], [things.assets.data]);
  const asset = assets.find((a) => a.id === assetId);
  const parts = useMemo(() => assets.filter((a) => a.parent_id === assetId), [assets, assetId]);
  const allPartIds = useMemo(() => {
    const out: string[] = [];
    const walk = (id: string) => {
      for (const a of assets) {
        if (a.parent_id === id && !out.includes(a.id)) {
          out.push(a.id);
          walk(a.id);
        }
      }
    };
    walk(assetId);
    return out;
  }, [assets, assetId]);

  if (!things.ready) return <div className="glass h-[420px] animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!asset) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="font-display text-xl font-semibold">{t('things.notFoundTitle')}</h1>
        <p className="text-[14px] text-muted">{t('things.notFoundBody')}</p>
        <Link to="/things" className="text-sm text-accent-b underline">
          {t('things.back')}
        </Link>
      </Card>
    );
  }

  const photo = things.photos.data?.get(asset.id);
  const categories = things.categories.data ?? [];
  const accounts = things.accounts.data ?? [];
  const templates = fieldsFor(things.fields.data ?? [], asset.category_id, categories);
  const custom = (asset.custom ?? {}) as Record<string, unknown>;
  const gone = ['sold', 'disposed', 'lost'].includes(asset.status);
  const category = asset.category_parent_name ? `${asset.category_parent_name} › ${asset.category_name}` : asset.category_name;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      await invalidateThings(qc, householdId);
      if (done) toast.success(done);
    } catch (e) {
      toast.error(t(`things.errors.${thingsErrorKey(e)}`));
    } finally {
      setBusy(false);
    }
  }

  function remove(a: Asset) {
    const key = thingsKey(householdId, 'assets');
    const { undo, ms } = scheduleUndoableDelete({
      id: a.id,
      hide: () => {
        qc.setQueryData<Asset[]>(key, (rows) => rows?.filter((r) => r.id !== a.id));
        void navigate({ to: '/things' });
      },
      commit: async () => {
        await deleteAsset(a.id);
        if (photo) await removeEntityPhoto(photo).catch(() => undefined);
      },
      restore: () => void invalidateThings(qc, householdId),
      onError: (e) => toast.error(t(`things.errors.${thingsErrorKey(e)}`)),
    });
    toast(t('things.deleted', { name: a.name }), { duration: ms, action: { label: t('common.undo'), onClick: undo } });
  }

  function removeLog(log: MaintenanceLog) {
    void act(() => deleteLog(log.id, log.created_expense), t(log.created_expense ? 'maintenance.log.deletedWithExpense' : 'maintenance.log.deleted'));
  }

  const lent = asset.status === 'lent';

  return (
    <div className="flex flex-col gap-5">
      <Link to="/things" className="-mb-2 inline-flex items-center gap-1 self-start text-[13px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.things')}
      </Link>

      <Card className="relative overflow-hidden p-0">
        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="relative aspect-[16/10] md:aspect-auto md:min-h-[300px]">
            <AssetArt name={asset.name} photo={photo} className="text-[44px]" />
          </div>
          <div className="flex flex-col gap-4 p-5 lg:p-6">
            <div>
              {category && <div className="text-[12.5px] text-muted">{category}</div>}
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight" data-testid="asset-name">
                {asset.name}
                {asset.quantity > 1 && <span className="tabular text-muted"> ×{asset.quantity}</span>}
              </h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="tabular rounded-full bg-white/10 px-2 py-0.5 text-[11.5px] text-text">{asset.tag}</span>
                <StatusBadge status={asset.status} />
                <WarrantyBadge asset={asset} today={today} long />
                {!gone && <DueChip nextDue={asset.next_due} today={today} />}
                {asset.insured && <span className="rounded-full bg-info/15 px-2 py-0.5 text-[11px] text-info">{t('things.insured')}</span>}
              </div>
              {lent && (
                <p className="mt-2 text-[14px] text-info">
                  {t('things.lentTo', { name: asset.lent_to, date: asset.lent_on ? formatDay(asset.lent_on, locale) : '' })}
                </p>
              )}
              {asset.status === 'sold' && (
                <p className="mt-2 text-[14px] text-muted">
                  {t('things.soldInfo', { date: asset.sold_on ? formatDay(asset.sold_on, locale) : '', to: asset.sold_to ?? t('things.someone') })}{' '}
                  {asset.sold_price !== null && <Money value={asset.sold_price} tone />}
                </p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <ValueLine
                label={t('things.value.paid')}
                value={asset.purchase_price}
                hint={asset.purchased_on ? formatDay(asset.purchased_on, locale) : undefined}
              />
              <ValueLine
                label={gone ? t('things.value.atEnd') : t('things.value.now')}
                value={gone ? asset.book_value : asset.current_value}
                hint={asset.useful_life_months ? t('things.value.life', { count: asset.useful_life_months }) : t('things.value.noLife')}
              />
              <div className="col-span-2">
                <dt className="text-[12px] text-muted">{t('things.value.place')}</dt>
                <dd className="mt-0.5 text-[15px]">
                  {asset.location_id ? (
                    <Link to="/places/$placeId" params={{ placeId: asset.location_id }} className="text-accent-b">
                      {asset.location_path}
                    </Link>
                  ) : (
                    <span className="text-muted">{t('things.noPlace')}</span>
                  )}
                  {asset.parent_id && (
                    <span className="block text-[13px] text-muted">
                      {t('things.partOf')}{' '}
                      <Link to="/things/$assetId" params={{ assetId: asset.parent_id }} className="text-accent-b">
                        {asset.parent_name} · {asset.parent_asset_no ? assetTag(asset.parent_asset_no) : ''}
                      </Link>
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-3">
              <CodeQr code={asset.code} className="h-[64px] w-[64px] shrink-0 p-1" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-muted">{t('places.labelCode')}</div>
                <div className="tabular truncate text-[15px] text-accent-b">{asset.code}</div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(asset.code).then(() => toast.success(t('places.copied')));
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-text"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  {t('places.copyCode')}
                </button>
              </div>
            </div>

            {canWrite && !gone && (
              <Button
                variant="primary"
                className="mt-auto w-full"
                onClick={() => {
                  setLogPlan(null);
                  setSheet('log');
                }}
              >
                <Wrench className="h-[18px] w-[18px]" aria-hidden />
                {t('maintenance.log.action')}
              </Button>
            )}
            {canWrite && asset.status === 'sold' && (
              <Button
                className="mt-auto w-full"
                disabled={busy}
                onClick={() => void act(() => unsellAsset(asset.id), t('things.sell.undone'))}
              >
                <RotateCcw className="h-[18px] w-[18px]" aria-hidden />
                {t('things.sell.undo')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-2 pb-1 sm:flex-wrap">
          {canWrite && !gone && <IconAction label={t('things.actions.move')} icon={ArrowRightLeft} onClick={() => setSheet('move')} />}
          {canWrite && !gone && !lent && <IconAction label={t('things.actions.lend')} icon={Handshake} onClick={() => setSheet('lend')} />}
          {canWrite && lent && (
            <IconAction
              label={t('things.actions.returned')}
              icon={RotateCcw}
              onClick={() => void act(() => updateAsset(asset.id, { status: 'in_use' }), t('things.lend.returned', { name: asset.name }))}
            />
          )}
          {canWrite && !gone && (
            <IconAction
              label={t('maintenance.plan.add')}
              icon={CalendarClock}
              onClick={() => {
                setPlanFor(null);
                setSheet('plan');
              }}
            />
          )}
          {canWrite && !gone && <IconAction label={t('things.actions.sell')} icon={HandCoins} onClick={() => setSheet('sell')} />}
          <IconAction
            label={t('places.label')}
            icon={Printer}
            onClick={() => void navigate({ to: '/places/labels', search: { assets: asset.id } })}
          />
          {canWrite && <IconAction label={t('things.actions.edit')} icon={Pencil} onClick={() => setSheet('edit')} />}
          {canWrite && asset.quantity > 1 && asset.quantity <= 100 && !gone && (
            <IconAction
              label={t('things.actions.split', { count: asset.quantity })}
              icon={Split}
              onClick={() => void act(() => splitAsset(asset.id), t('things.split.done', { count: asset.quantity, name: asset.name }))}
            />
          )}
          {canWrite && <IconAction label={t('things.actions.delete')} icon={Trash2} danger onClick={() => remove(asset)} />}
        </div>
      </div>

      <Section title={t('things.sections.details')}>
        <Card>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[14.5px] sm:grid-cols-3">
            <Detail label={t('things.form.maker')} value={asset.manufacturer} />
            <Detail label={t('things.form.model')} value={asset.model_no} mono />
            <Detail label={t('things.form.serial')} value={asset.serial_no} mono />
            <Detail label={t('things.form.condition')} value={asset.condition ? t(`things.condition.${asset.condition as 'new'}`) : null} />
            <Detail label={t('things.form.vendor')} value={asset.vendor} />
            {templates.map((f) => (
              <Detail key={f.key} label={f.label} value={displayValue(f, custom[f.key], t('things.yes'), locale) || null} mono={f.type === 'number'} />
            ))}
            {asset.tag_names.length > 0 && <Detail label={t('things.form.tags')} value={asset.tag_names.map((n) => `#${n}`).join(' ')} />}
            {asset.warranty_notes && <Detail label={t('things.form.warrantyNotes')} value={asset.warranty_notes} />}
            {asset.insurance_notes && <Detail label={t('things.form.insuranceNotes')} value={asset.insurance_notes} />}
          </dl>
          {asset.description && <p className="mt-3 text-[14px] leading-relaxed whitespace-pre-line text-[#c5cce3]">{asset.description}</p>}
          {asset.bill_id && (
            <Link to="/money/tx/$txId" params={{ txId: asset.bill_id }} className="mt-3 inline-block text-[13.5px] text-accent-b">
              {t('things.fromBill', { shop: asset.bill_payee ?? '', date: asset.bill_date ? formatDay(asset.bill_date, locale) : '' })}
            </Link>
          )}
        </Card>
      </Section>

      <Section title={t('things.sections.value')}>
        <Card>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ValueLine label={t('things.value.paid')} value={asset.purchase_price} />
            <ValueLine label={t('things.value.maintenance')} value={asset.maintenance_cost} />
            <ValueLine
              label={t('things.value.ownership')}
              value={asset.cost_of_ownership}
              hint={asset.months_owned !== null ? t('things.value.months', { count: asset.months_owned }) : undefined}
            />
            <ValueLine label={t('things.value.perMonth')} value={asset.cost_per_month} />
            {asset.sale_gain !== null && (
              <div>
                <dt className="text-[12px] text-muted">{t('things.value.saleGain')}</dt>
                <dd className="mt-0.5 text-[17px]">
                  <Money value={asset.sale_gain} tone plus />
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-[12.5px] text-faint">{t('things.value.explain')}</p>
        </Card>
      </Section>

      {parts.length > 0 && (
        <Section title={t('things.sections.parts')} aside={<span className="tabular text-[14px] text-muted">{parts.length}</span>}>
          <ul className="flex flex-col gap-1.5">
            {parts.map((p) => (
              <li key={p.id}>
                <Link to="/things/$assetId" params={{ assetId: p.id }} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
                  <span className="tabular text-[12px] text-muted">{p.tag}</span>
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">{p.name}</span>
                  <StatusBadge status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('things.sections.maintenance')}>
        {(plans.data ?? []).length === 0 && (logs.data ?? []).length === 0 ? (
          <p className="text-[14px] text-[#a5b0d0]">{t('maintenance.empty')}</p>
        ) : null}
        {(plans.data ?? []).length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="plans">
            {(plans.data ?? []).map((p) => (
              <li key={p.id} className="glass flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px]">{p.name}</div>
                  <div className="tabular text-[12.5px] text-muted">
                    {p.every_days ? t('maintenance.every', { count: p.every_days }) : ''}
                    {p.every_usage ? ` ${t('maintenance.everyUsage', { n: p.every_usage, unit: p.usage_unit ?? '' })}` : ''}
                    {p.next_due ? ` · ${t('maintenance.next', { date: formatDay(p.next_due, locale) })}` : ''}
                    {p.active ? '' : ` · ${t('maintenance.paused')}`}
                  </div>
                </div>
                {p.active && <DueChip nextDue={p.next_due} today={today} />}
                {canWrite && (
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => {
                        setLogPlan(p.id);
                        setSheet('log');
                      }}
                    >
                      {t('maintenance.log.short')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('maintenance.plan.editTitle')}
                      onClick={() => {
                        setPlanFor(p);
                        setSheet('plan');
                      }}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {(logs.data ?? []).length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="logs">
            {(logs.data ?? []).map((l) => (
              <li key={l.id} className="flex items-center gap-3 rounded-2xl bg-white/[0.03] px-4 py-3" data-testid="log">
                <span className="tabular w-16 shrink-0 text-[12.5px] text-muted">{formatDay(l.done_on, locale)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px]">{l.title}</span>
                  {l.vendor && <span className="block truncate text-[12px] text-muted">{l.vendor}</span>}
                </span>
                {l.cost !== null &&
                  (l.transaction_id ? (
                    <Link to="/money/tx/$txId" params={{ txId: l.transaction_id }} className="text-accent-b">
                      <Money value={l.cost} className="text-[14px]" />
                    </Link>
                  ) : (
                    <Money value={l.cost} className="text-[14px]" />
                  ))}
                {canWrite && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t('maintenance.log.remove', { title: l.title })}
                    onClick={() => removeLog(l)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-white/5"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('things.sections.documents')}>
        <DocumentsPanel
          householdId={householdId}
          entityType="asset"
          entityId={asset.id}
          canWrite={canWrite}
          locale={locale}
          billId={asset.bill_id}
          defaultKind={asset.bill_id ? 'warranty' : 'receipt'}
        />
      </Section>

      <Section title={t('things.sections.timeline')}>
        <AssetTimeline asset={asset} activity={activity.data ?? []} logs={logs.data ?? []} locale={locale} timezone={timezone} />
      </Section>

      <AssetForm
        open={sheet === 'edit'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        locale={locale}
        categories={categories}
        tree={things.tree}
        assets={assets}
        tags={things.tags.data ?? []}
        fields={things.fields.data ?? []}
        asset={asset}
        photo={photo}
      />
      <AssetMoveSheet
        open={sheet === 'move'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        asset={asset}
        partIds={allPartIds}
        tree={things.tree}
      />
      <LendSheet open={sheet === 'lend'} onClose={() => setSheet(null)} householdId={householdId} timezone={timezone} asset={asset} />
      <SellSheet
        open={sheet === 'sell'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        timezone={timezone}
        asset={asset}
        accounts={accounts}
        categories={categories}
      />
      <LogServiceSheet
        open={sheet === 'log'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        timezone={timezone}
        locale={locale}
        asset={asset}
        plans={(plans.data ?? []).filter((p) => p.active)}
        planId={logPlan}
        accounts={accounts}
        categories={categories}
      />
      <PlanSheet
        open={sheet === 'plan'}
        onClose={() => setSheet(null)}
        householdId={householdId}
        timezone={timezone}
        asset={asset}
        plan={planFor}
        categories={categories}
      />
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className={mono ? 'tabular mt-0.5 break-words' : 'mt-0.5 break-words'}>{value}</dd>
    </div>
  );
}
