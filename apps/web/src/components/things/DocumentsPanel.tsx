import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { selectClass } from '@/components/money/bits';
import {
  DOC_KINDS,
  FileError,
  attachmentUrl,
  formatBytes,
  removeAttachment,
  uploadDocument,
  type Attachment,
  type DocEntity,
  type DocKind,
} from '@/lib/files';
import { ImageError } from '@/lib/images';
import { docsQuery, thingsErrorKey, thingsKey } from '@/lib/things/queries';
import { formatDay } from '@/lib/time';
import { isPendingDelete, scheduleUndoableDelete } from '@/lib/undo';
import { cn } from '@/lib/utils';

/** Open a private file: the tab is opened first (a popup blocker allows that), then pointed at a signed URL. */
async function openFile(a: Attachment) {
  const w = window.open('', '_blank');
  try {
    const url = await attachmentUrl(a);
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

/**
 * Receipts, warranty cards, manuals … of one thing / bill / service. `billId` also lists the files of
 * the bill the thing was bought on ("where's the TV receipt?", MASTER_PLAN §4 row 8) — read-only here.
 */
export function DocumentsPanel({
  householdId,
  entityType,
  entityId,
  canWrite,
  locale,
  billId,
  defaultKind = 'receipt',
}: {
  householdId: string;
  entityType: DocEntity;
  entityId: string;
  canWrite: boolean;
  locale: string;
  billId?: string | null;
  defaultKind?: DocKind;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const docs = useQuery(docsQuery(householdId, entityType, [entityId]));
  const billDocs = useQuery(docsQuery(householdId, 'transaction', billId ? [billId] : []));
  const [kind, setKind] = useState<DocKind>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [, setHidden] = useState(0);

  const refresh = () => qc.invalidateQueries({ queryKey: thingsKey(householdId, 'docs') });

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        await uploadDocument(householdId, entityType, entityId, f, kind);
        ok++;
      } catch (e) {
        toast.error(
          e instanceof FileError
            ? t(`things.docs.errors.${e.reason}`)
            : e instanceof ImageError
              ? t(`places.photoErrors.${e.reason}`)
              : t(`things.errors.${thingsErrorKey(e)}`),
        );
      }
    }
    await refresh();
    setBusy(false);
    if (ok) toast.success(t('things.docs.added', { count: ok }));
  }

  function remove(a: Attachment) {
    const { undo, ms } = scheduleUndoableDelete({
      id: a.id,
      hide: () => setHidden((n) => n + 1),
      commit: () => removeAttachment(a),
      restore: () => {
        setHidden((n) => n + 1);
        void refresh();
      },
      onError: (e) => toast.error(t(`things.errors.${thingsErrorKey(e)}`)),
    });
    toast(t('things.docs.removed', { name: a.title ?? t(`things.docs.kinds.${a.kind as DocKind}`) }), {
      duration: ms,
      action: { label: t('common.undo'), onClick: undo },
    });
  }

  const mine = (docs.data ?? []).filter((a) => !isPendingDelete(a.id));
  const fromBill = billDocs.data ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="documents">
      {mine.length === 0 && fromBill.length === 0 && !docs.isPending && (
        <p className="text-[14px] text-[#a5b0d0]">{t(`things.docs.empty.${entityType}`)}</p>
      )}
      {mine.length > 0 && (
        <ul className="flex flex-col gap-2">
          {mine.map((a) => (
            <DocRow key={a.id} doc={a} locale={locale} onRemove={canWrite ? () => remove(a) : undefined} />
          ))}
        </ul>
      )}
      {fromBill.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-muted">{t('things.docs.fromBill')}</div>
          <ul className="flex flex-col gap-2">
            {fromBill.map((a) => (
              <DocRow key={a.id} doc={a} locale={locale} />
            ))}
          </ul>
        </div>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('things.docs.kind')}
            className={cn(selectClass, 'h-11 w-auto min-w-[9rem] px-3 text-[15px]')}
            value={kind}
            onChange={(e) => setKind(e.target.value as DocKind)}
          >
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`things.docs.kinds.${k}`)}
              </option>
            ))}
          </select>
          <label
            className={cn(
              'glass inline-flex h-11 cursor-pointer items-center gap-2 rounded-[14px] px-4 text-[14px]',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <Paperclip className="h-4 w-4" aria-hidden />
            {busy ? t('things.docs.uploading') : t('things.docs.add')}
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="sr-only"
              data-testid="doc-input"
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <span className="text-[12px] text-faint">{t('things.docs.hint')}</span>
        </div>
      )}
    </div>
  );
}

function DocRow({ doc, locale, onRemove }: { doc: Attachment; locale: string; onRemove?: () => void }) {
  const { t } = useTranslation();
  const label = t(`things.docs.kinds.${doc.kind as DocKind}`);
  return (
    <li className="glass flex items-center gap-3 rounded-2xl p-2 pr-1.5" data-testid="doc">
      <button
        type="button"
        onClick={() => void openFile(doc).catch(() => toast.error(t('things.docs.errors.open')))}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/[0.05]">
          {doc.thumbUrl ? <img src={doc.thumbUrl} alt="" className="h-full w-full object-cover" /> : <FileText className="h-5 w-5 text-accent-b" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px]">{doc.title ?? label}</span>
          <span className="tabular block truncate text-[12px] text-muted">
            {label} · {formatDay(doc.created_at.slice(0, 10), locale)}
            {doc.bytes ? ` · ${formatBytes(doc.bytes, locale)}` : ''}
          </span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={t('things.docs.remove', { name: doc.title ?? label })}
          onClick={onRemove}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-white/5"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </li>
  );
}
