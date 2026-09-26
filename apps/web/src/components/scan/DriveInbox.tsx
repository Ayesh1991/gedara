// Money › Import › From Drive: files the claude.ai Bill Scanner saved in the Drive folder (migration
// 54, drive-scan). Bills open in the normal import flow; warranty cards and rating plates fill in a
// thing. Nothing is saved without a person confirming it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CircleAlert, CloudDownload, FileJson, FolderSync, ReceiptText, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/aurora/EmptyState';
import { BillImport } from '@/components/money/BillImport';
import { AssetForm } from '@/components/things/AssetForm';
import { useThings } from '@/components/things/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { ThingDoc } from '@/lib/money/billSchema';
import type { CategoryRow } from '@/lib/money/categoriesMap';
import type { Account } from '@/lib/money/queries';
import { docPrefill, matchThing } from '@/lib/scan/docs';
import {
  driveSourceQuery,
  folderIdFrom,
  ignoreScanFile,
  invalidateScan,
  linkScanFileAsset,
  scanFilesQuery,
  setDriveFolder,
  syncDrive,
  type ScanFile,
  type ScanStatus,
} from '@/lib/scan/queries';
import { formatDay } from '@/lib/time';
import { invalidateThings } from '@/lib/things/queries';
import { cn } from '@/lib/utils';
import { useDriveSync } from './useDriveSync';

const KNOWN_ERRORS = ['not_configured', 'google_auth', 'folder_not_shared', 'drive_list', 'forbidden', 'network'] as const;
type ScanError = (typeof KNOWN_ERRORS)[number] | 'generic';
const errorKey = (e: string | null | undefined): ScanError =>
  (KNOWN_ERRORS as readonly string[]).includes(e ?? '') ? (e as ScanError) : 'generic';
type Kind = 'bill' | 'warranty' | 'rating_plate' | 'null';
const kindKey = (d: string | null | undefined): Kind => (d === 'bill' || d === 'warranty' || d === 'rating_plate' ? d : 'null');

export function DriveInbox({
  householdId,
  locale,
  today,
  accounts,
  categories,
  isOwner,
}: {
  householdId: string;
  locale: string;
  today: string;
  accounts: Account[];
  categories: CategoryRow[];
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const source = useQuery(driveSourceQuery(householdId));
  const files = useQuery(scanFilesQuery(householdId));
  const [open, setOpen] = useState<ScanFile | null>(null);
  const [checking, setChecking] = useState(false);
  useDriveSync(householdId, Boolean(source.data));

  const { waiting, done } = useMemo(() => {
    const all = files.data ?? [];
    return { waiting: all.filter((f) => f.status === 'waiting' || f.status === 'error'), done: all.filter((f) => f.status === 'imported' || f.status === 'ignored') };
  }, [files.data]);

  async function checkNow() {
    setChecking(true);
    const r = await syncDrive(householdId, true);
    setChecking(false);
    await invalidateScan(qc, householdId);
    if (r.ok && r.skipped === 'recent') toast(t('scanInbox.checkedRecently'));
    else if (r.ok) toast.success(t('scanInbox.checked', { count: r.stored ?? 0 }));
    else toast.error(t(`scanInbox.errors.${errorKey(r.error)}`));
  }

  async function ignore(f: ScanFile, value: boolean) {
    try {
      await ignoreScanFile(f.id!, value);
      await invalidateScan(qc, householdId);
    } catch {
      toast.error(t('scanInbox.errors.generic'));
    }
  }

  if (source.isPending || files.isPending) return <div className="glass h-40 animate-pulse rounded-[var(--r)]" aria-hidden />;
  if (!source.data) return <ConnectFolder householdId={householdId} isOwner={isOwner} />;

  if (open) {
    const back = () => {
      setOpen(null);
      void invalidateScan(qc, householdId);
    };
    return (
      <div className="flex flex-col gap-4">
        <button type="button" onClick={back} className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('scanInbox.back')}
        </button>
        {open.doc_type === 'bill' ? (
          <BillImport
            key={open.id}
            householdId={householdId}
            locale={locale}
            today={today}
            accounts={accounts}
            categories={categories}
            initialText={JSON.stringify(open.payload)}
          />
        ) : (
          <ThingDocs file={open} householdId={householdId} locale={locale} onDone={back} />
        )}
      </div>
    );
  }

  const lastError = source.data.last_error;
  return (
    <div className="flex flex-col gap-4" data-testid="drive-inbox">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="flex-1 text-[13.5px] text-muted">
          {source.data.last_sync_at
            ? t('scanInbox.lastChecked', { when: formatDay(source.data.last_sync_at.slice(0, 10), locale, today.slice(0, 4)) })
            : t('scanInbox.neverChecked')}
        </p>
        <Button size="sm" onClick={() => void checkNow()} disabled={checking}>
          <FolderSync className="h-4 w-4" aria-hidden />
          {t('scanInbox.checkNow')}
        </Button>
      </div>
      {lastError && (
        <Card className="flex items-start gap-2.5 border-caution/40 text-[13.5px]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden />
          {t(`scanInbox.errors.${errorKey(lastError)}`)}
        </Card>
      )}

      {waiting.length === 0 ? (
        <EmptyState icon={CloudDownload} title={t('scanInbox.emptyTitle')} body={t('scanInbox.emptyBody')} />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {waiting.map((f) => (
            <FileRow key={f.id} file={f} locale={locale} today={today} onOpen={() => setOpen(f)} onIgnore={() => void ignore(f, true)} />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <details className="glass rounded-2xl px-4 py-3">
          <summary className="cursor-pointer text-[14px] font-medium">{t('scanInbox.done', { count: done.length })}</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {done.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-[13.5px]">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-muted">{t(`scanInbox.status.${f.status as ScanStatus}`)}</span>
                {f.status === 'ignored' && (
                  <Button size="sm" variant="ghost" onClick={() => void ignore(f, false)}>
                    {t('scanInbox.showAgain')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FileRow({ file, locale, today, onOpen, onIgnore }: { file: ScanFile; locale: string; today: string; onOpen: () => void; onIgnore: () => void }) {
  const { t } = useTranslation();
  const Icon = file.doc_type === 'bill' ? ReceiptText : file.doc_type ? ShieldCheck : FileJson;
  const error = file.status === 'error';
  return (
    <li className="glass flex flex-wrap items-center gap-3 rounded-2xl px-3.5 py-3" data-testid="scan-file">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5', error ? 'text-caution' : 'text-accent-b')}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium">{file.name}</div>
        <div className="text-[12.5px] text-muted">
          {error
            ? file.parse_error
            : file.doc_type === 'bill'
              ? t('scanInbox.bills', { done: file.bills_imported ?? 0, count: file.bills_total ?? 0 })
              : t(`scanInbox.kind.${kindKey(file.doc_type)}`)}
          {file.modified_at && <span className="tabular"> · {formatDay(file.modified_at.slice(0, 10), locale, today.slice(0, 4))}</span>}
        </div>
      </div>
      {!error && (
        <Button size="sm" variant="accent" onClick={onOpen}>
          {t('scanInbox.open')}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onIgnore}>
        {t('scanInbox.ignore')}
      </Button>
    </li>
  );
}

function ConnectFolder({ householdId, isOwner }: { householdId: string; isOwner: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const id = folderIdFrom(link);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setBusy(true);
    try {
      await setDriveFolder(householdId, id);
      await invalidateScan(qc, householdId);
      await syncDrive(householdId, true);
      await invalidateScan(qc, householdId);
    } catch {
      toast.error(t('scanInbox.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-display text-[18px] font-semibold">{t('scanInbox.connectTitle')}</h2>
      <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('scanInbox.connectBody')}</p>
      {isOwner ? (
        <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label={t('scanInbox.folderLink')}
            placeholder="https://drive.google.com/drive/folders/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!id || busy}>
            {t('scanInbox.connect')}
          </Button>
        </form>
      ) : (
        <p className="text-[13.5px] text-muted">{t('scanInbox.ownerOnly')}</p>
      )}
    </Card>
  );
}

/** Warranty cards / rating plates: fill in a new thing, or the thing it is about. */
function ThingDocs({ file, householdId, locale, onDone }: { file: ScanFile; householdId: string; locale: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const things = useThings(householdId);
  const docs = (Array.isArray(file.payload) ? file.payload : []) as ThingDoc[];
  const doc = docs[0];
  const assets = things.assets.data ?? [];
  const guess = doc ? matchThing(doc, assets) : null;
  // Until the person picks, the best match (same serial / model) is preselected.
  const [picked, setTarget] = useState<string | null>(null);
  const target = picked ?? guess?.id ?? '';
  const [form, setForm] = useState<'new' | 'existing' | null>(null);
  if (!doc) return <Card className="text-[14px] text-muted">{t('scanInbox.errors.generic')}</Card>;
  const prefill = docPrefill(doc);
  const chosen = assets.find((a) => a.id === target) ?? null;
  const rows: [string, string | null | undefined][] = [
    [t('things.form.maker'), prefill.maker],
    [t('things.form.model'), prefill.model],
    [t('things.form.serial'), prefill.serial],
    [t('things.form.boughtOn'), prefill.purchased_on],
    [t('things.form.vendor'), prefill.vendor],
    [t('things.form.warrantyUntil'), prefill.lifetime_warranty ? t('things.form.lifetime') : prefill.warranty_until],
    [t('scanInbox.details'), prefill.description],
  ];

  async function saved(assetId: string) {
    await linkScanFileAsset(file.id!, assetId);
    await Promise.all([invalidateScan(qc, householdId), invalidateThings(qc, householdId)]);
    toast.success(t('scanInbox.thingSaved'));
    onDone();
  }

  return (
    <Card className="flex flex-col gap-4" data-testid="thing-doc">
      <div>
        <div className="text-[12.5px] text-muted">{t(`scanInbox.kind.${kindKey(file.doc_type)}`)}</div>
        <h2 className="font-display text-[20px] font-semibold">{prefill.name || file.name}</h2>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="tabular whitespace-pre-line">{v}</dd>
            </div>
          ))}
      </dl>
      <label className="flex flex-col gap-1.5 text-[13.5px]">
        <span className="text-muted">{t('scanInbox.whichThing')}</span>
        <select className="glass h-11 rounded-xl px-3" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t('scanInbox.aNewThing')}</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <Button variant="primary" onClick={() => setForm(chosen ? 'existing' : 'new')}>
        {chosen ? t('scanInbox.fillIn', { name: chosen.name }) : t('scanInbox.newThing')}
      </Button>
      {things.categories.data && (
        <AssetForm
          open={form !== null}
          onClose={() => setForm(null)}
          householdId={householdId}
          locale={locale}
          categories={things.categories.data}
          tree={things.tree}
          assets={assets}
          tags={things.tags.data ?? []}
          fields={things.fields.data ?? []}
          asset={form === 'existing' ? chosen : null}
          initial={prefill}
          onSaved={(id) => void saved(id)}
        />
      )}
    </Card>
  );
}
