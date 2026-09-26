import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, HardDriveDownload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { attentionKey } from '@/lib/insights/queries';
import type { Progress } from '@/lib/export/build';
import { supabase } from '@/lib/supabase';
import { formatDay, todayIn } from '@/lib/time';

export const Route = createFileRoute('/_app/settings/export')({
  component: ExportPage,
});

const lastExportQuery = (householdId: string) => ({
  queryKey: ['export-runs', householdId],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('export_run')
      .select('created_at, bytes, with_files')
      .eq('household_id', householdId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
});

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Settings › Export (MASTER_PLAN §5.2): everything in one zip you keep yourself. */
function ExportPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, locale, timezone } = membership.household;
  const today = todayIn(timezone);
  const last = useQuery(lastExportQuery(householdId));
  const [withFiles, setWithFiles] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);

  async function run() {
    const { buildExport, openSink } = await import('@/lib/export/build');
    const name = `gedara-backup-${today}.zip`;
    const target = await openSink(name);
    if (!target) return;
    setProgress({ step: 'tables', done: 0, total: 1 });
    try {
      const r = await buildExport({ householdId, withFiles, sink: target.sink, onProgress: setProgress });
      target.finish();
      toast.success(t('export.done', { size: mb(r.bytes) }));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['export-runs', householdId] }),
        qc.invalidateQueries({ queryKey: attentionKey(householdId) }),
      ]);
    } catch {
      toast.error(t('export.failed'));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('nav.settings')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('export.title')}</h1>
        <p className="mt-1 text-[14.5px] text-muted">{t('export.intro')}</p>
      </div>

      <Card className="flex flex-col gap-4">
        <p className="text-[14px]" data-testid="last-export">
          {last.data
            ? t('export.last', {
                when: formatDay(last.data.created_at.slice(0, 10), locale, today.slice(0, 4)),
                size: last.data.bytes ? mb(Number(last.data.bytes)) : '—',
              })
            : t('export.never')}
        </p>
        <label className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent-a)]" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
          <span>
            {t('export.withFiles')}
            <span className="block text-[12.5px] text-muted">{t('export.withFilesHint')}</span>
          </span>
        </label>
        <Button variant="primary" onClick={() => void run()} disabled={progress !== null} data-testid="export-run">
          <HardDriveDownload className="h-[18px] w-[18px]" aria-hidden />
          {progress
            ? t(`export.progress.${progress.step}`, { done: progress.done + 1, total: progress.total })
            : t('export.download')}
        </Button>
        <p className="text-[12.5px] leading-relaxed text-muted">{t('export.keepSafe')}</p>
      </Card>
    </div>
  );
}
