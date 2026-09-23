import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { CHECK_IDS, buildChecks, runCheck, type CheckId, type CheckResult } from '@/diagnostics/checks';
import { env } from '@/lib/env';
import { schemaVersionQuery } from '@/lib/queries';
import { supabase } from '@/lib/supabase';
import { APP_VERSION, BUILD_TIME, GIT_SHA } from '@/lib/version';
import { useCountUp } from '@/hooks/useCountUp';
import { clearCacheAndReload, getServiceWorkerVersion } from '@/pwa/register';

const CHECK_TIMEOUT_MS = 8000;

export const Route = createFileRoute('/_app/settings/diagnostics')({
  component: DiagnosticsPage,
});

function Ms({ value }: { value: number }) {
  const shown = useCountUp(value, 600);
  return <span className="tabular text-xs text-muted">{Math.round(shown)} ms</span>;
}

function DiagnosticsPage() {
  const { t } = useTranslation();
  const schema = useQuery(schemaVersionQuery);
  const sw = useQuery({ queryKey: ['sw-version'], queryFn: () => getServiceWorkerVersion(), staleTime: 0 });
  // Bumping runId re-runs every check (fresh query keys, never cached).
  const [runId, setRunId] = useState(0);

  const checks = useMemo(
    () => buildChecks({ supabase, appVersion: APP_VERSION, getSwVersion: () => getServiceWorkerVersion() }),
    [],
  );

  const queries = useQueries({
    queries: CHECK_IDS.map((id) => ({
      queryKey: ['diagnostics', id, runId],
      queryFn: () =>
        runCheck(id, checks[id], {
          timeoutMs: CHECK_TIMEOUT_MS,
          t: (key: string, params?: Record<string, string | number>) => t(key as never, params),
        }),
      retry: false,
      staleTime: Infinity,
      gcTime: 0,
      refetchOnWindowFocus: false,
    })),
  });

  const results: Partial<Record<CheckId, CheckResult>> = {};
  queries.forEach((q, i) => {
    if (q.data) results[CHECK_IDS[i]!] = q.data;
  });
  const done = Object.values(results);
  const running = done.length < CHECK_IDS.length;
  const failed = done.filter((r) => !r.ok).length;
  const swVersion = sw.isPending ? undefined : (sw.data ?? null);

  const versionRows: Array<[string, string]> = [
    [t('diagnostics.appVersion'), `v${APP_VERSION}`],
    [t('diagnostics.gitSha'), GIT_SHA],
    [t('diagnostics.buildTime'), BUILD_TIME],
    [t('diagnostics.environment'), env.VITE_APP_ENV],
    [t('diagnostics.schemaVersion'), schema.data != null ? String(schema.data) : t('common.unknown')],
    [
      t('diagnostics.swVersion'),
      swVersion === undefined ? t('common.loading') : swVersion ? `v${swVersion}` : t('diagnostics.swNone'),
    ],
  ];

  return (
    <div className="space-y-4">
      <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('diagnostics.title')}</h1>

      <Card>
        <CardTitle>{t('diagnostics.version')}</CardTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {versionRows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular break-all text-right" data-testid={`diag-${label}`}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <CardTitle className="flex items-center justify-between gap-3">
          <span>{t('diagnostics.test')}</span>
          {!running && done.length === CHECK_IDS.length && (
            <span className={failed ? 'text-sm text-red' : 'text-sm text-teal'} data-testid="diag-summary">
              {failed ? t('diagnostics.someFailed', { count: failed }) : t('diagnostics.allGreen')}
            </span>
          )}
        </CardTitle>
        <ul className="divide-y divide-line">
          {CHECK_IDS.map((id) => {
            const r = results[id];
            return (
              <li key={id} className="flex items-start gap-3 py-2.5" data-testid={`check-${id}`} data-ok={r?.ok}>
                {!r ? (
                  <LoaderCircle className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted" aria-hidden />
                ) : r.ok ? (
                  <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden />
                ) : (
                  <CircleX className="mt-0.5 h-5 w-5 shrink-0 text-red" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="font-display">{t(`diagnostics.checks.${id}`)}</span>
                    {r && <Ms value={r.ms} />}
                  </div>
                  {r && (
                    <div className={`tabular break-all text-xs ${r.ok ? 'text-muted' : 'text-red'}`}>
                      {r.ok ? r.detail : r.error}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <Button variant="accent" className="mt-4 w-full" disabled={running} onClick={() => setRunId((n) => n + 1)}>
          {running ? t('diagnostics.testing') : t('diagnostics.test')}
        </Button>
      </Card>

      <Button className="w-full" onClick={() => void clearCacheAndReload()}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        {t('diagnostics.clearCache')}
      </Button>
    </div>
  );
}
