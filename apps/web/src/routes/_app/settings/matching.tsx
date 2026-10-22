import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, FlaskConical, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fieldLabel } from '@/components/money/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  TooOften,
  agentStatusQuery,
  checkKeys,
  evalBatch,
  matchReportQuery,
  matchSettingQuery,
  saveMatchSetting,
  suggestionsQuery,
  type Accuracy,
} from '@/lib/match/queries';
import { todayIn } from '@/lib/time';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings/matching')({
  component: MatchingPage,
});

const PROVIDER_NAMES = { groq: 'Groq', gemini: 'Google Gemini', openai: 'OpenAI' } as const;
/** 9c may book a kind by itself only when its "sure" answers were this good, on at least this many. */
const AUTO_AT = { precision: 0.99, min: 30 };

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—');
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/**
 * Settings › Matching (Phase 9b): the AI in shadow. The owner switches AI suggestions on, sets the
 * monthly cost cap, tests the keys, and runs the accuracy test on the household's own decided data;
 * everyone sees the report, this month's cost and the recent runs. Nothing here books anything.
 */
function MatchingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { membership } = Route.useRouteContext();
  const { id: householdId, timezone } = membership.household;
  const isOwner = membership.role === 'owner';
  const month = `${todayIn(timezone).slice(0, 7)}-01`;
  const setting = useQuery(matchSettingQuery(householdId));
  const status = useQuery(agentStatusQuery());
  const report = useQuery(matchReportQuery(householdId, month));
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState<string | null>(null);
  const [daily, setDaily] = useState<string | null>(null);
  const [keyResults, setKeyResults] = useState<Array<{ provider: string; model: string; ok: boolean; error: string | null }> | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: matchSettingQuery(householdId).queryKey });
    void qc.invalidateQueries({ queryKey: matchReportQuery(householdId, month).queryKey });
    void qc.invalidateQueries({ queryKey: suggestionsQuery(householdId).queryKey });
  };

  async function save(p: Parameters<typeof saveMatchSetting>[1]) {
    setBusy(true);
    try {
      await saveMatchSetting(householdId, p);
      toast.success(t('matching.saved'));
      refresh();
    } catch {
      toast.error(t('matching.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function testKeys() {
    setBusy(true);
    try {
      setKeyResults((await checkKeys(householdId)).results);
      refresh();
    } catch (err) {
      toast.error(err instanceof TooOften ? t('match.tooOften') : t('match.failed'));
    } finally {
      setBusy(false);
    }
  }

  /** The test runs in batches (one call each, a few dozen questions); it continues while the page is open. */
  async function runTest() {
    stop.current = false;
    setProgress({ done: 0, total: 0 });
    try {
      for (;;) {
        let r: Awaited<ReturnType<typeof evalBatch>>;
        try {
          r = await evalBatch(householdId);
        } catch (err) {
          if (!(err instanceof TooOften)) throw err;
          await new Promise((ok) => setTimeout(ok, 21_000)); // the database allows one batch per 20 s
          continue;
        }
        setProgress({ done: r.total - r.remaining, total: r.total });
        void qc.invalidateQueries({ queryKey: matchReportQuery(householdId, month).queryKey });
        if (r.remaining === 0 || stop.current) break;
        await new Promise((ok) => setTimeout(ok, 21_000));
      }
      toast.success(t('matching.testDone'));
    } catch {
      toast.error(t('match.failed'));
    } finally {
      setProgress(null);
      refresh();
    }
  }

  const s = setting.data;
  const costTotal = (report.data?.cost ?? []).reduce((a, c) => a + c.cost_usd, 0);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/settings" className="flex items-center gap-1 self-start text-[14px] text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('settings.title')}
      </Link>
      <div>
        <h1 className="font-display text-[30px] font-semibold tracking-tight">{t('matching.title')}</h1>
        <p className="mt-1 max-w-prose text-[14.5px] text-muted">{t('matching.intro')}</p>
      </div>

      {/* On / off */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 shrink-0 text-info" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('matching.aiTitle')}</div>
            <div className="text-[13px] text-muted">{t(s?.ai_enabled ? 'matching.aiOn' : 'matching.aiOffHint')}</div>
          </div>
          <Toggle
            on={!!s?.ai_enabled}
            disabled={!isOwner || busy || !s}
            label={t('matching.aiTitle')}
            onChange={(on) => void save({ ai_enabled: on })}
          />
        </div>
        <p className="flex items-start gap-2 text-[12.5px] text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden />
          {t('matching.privacy')}
        </p>
      </Card>

      {/* The ladder */}
      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-[18px] font-semibold">{t('matching.modelsTitle')}</h2>
        <ol className="flex flex-col gap-2">
          {(s?.steps ?? []).map((step, i) => {
            const result = keyResults?.find((r) => r.provider === step.provider && r.model === step.model);
            const hasKey = status.data?.keys[step.provider];
            return (
              <li key={`${step.provider}/${step.model}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-white/[0.035] px-3 py-2.5">
                <span className="tabular text-[12px] text-faint">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{PROVIDER_NAMES[step.provider]}</span>
                  <span className="ml-2 font-mono text-[12px] text-muted">{step.model}</span>
                  <span className="block text-[12px] text-muted">{t(`matching.role${i}` as 'matching.role0')}</span>
                </span>
                <span className={cn('text-[12.5px]', hasKey ? 'text-teal' : 'text-caution')}>
                  {status.isPending ? '…' : hasKey ? t('matching.keySet') : t('matching.keyMissing')}
                </span>
                {result && (
                  <span className={cn('text-[12.5px]', result.ok ? 'text-teal' : 'text-red')}>
                    {result.ok ? t('matching.keyWorks') : t('matching.keyFails', { error: result.error ?? '?' })}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {isOwner && (
          <Button variant="secondary" size="sm" className="self-start" disabled={busy} onClick={() => void testKeys()}>
            <KeyRound className="h-4 w-4" aria-hidden />
            {t('matching.testKeys')}
          </Button>
        )}
        <p className="text-[12.5px] text-muted">{t('matching.keysHow')}</p>
      </Card>

      {/* Limits and this month's cost */}
      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-[18px] font-semibold">{t('matching.costTitle')}</h2>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={fieldLabel} htmlFor="match-cap">{t('matching.cap')}</label>
            <Input id="match-cap" inputMode="decimal" className="tabular" disabled={!isOwner}
              value={cap ?? String(s?.monthly_cap_usd ?? '')} onChange={(e) => setCap(e.target.value)} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="match-daily">{t('matching.daily')}</label>
            <Input id="match-daily" inputMode="numeric" className="tabular" disabled={!isOwner}
              value={daily ?? String(s?.daily_requests ?? '')} onChange={(e) => setDaily(e.target.value)} />
          </div>
        </div>
        {isOwner && (cap !== null || daily !== null) && (
          <Button size="sm" variant="accent" className="self-start" disabled={busy}
            onClick={() => void save({
              ...(cap !== null ? { monthly_cap_usd: Number(cap) } : {}),
              ...(daily !== null ? { daily_requests: Math.round(Number(daily)) } : {}),
            }).then(() => { setCap(null); setDaily(null); })}>
            {t('matching.save')}
          </Button>
        )}
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-muted">
            <tr><th className="py-1 font-normal">{t('matching.model')}</th><th className="font-normal">{t('matching.requests')}</th><th className="text-right font-normal">{t('matching.cost')}</th></tr>
          </thead>
          <tbody className="tabular">
            {(report.data?.cost ?? []).map((c) => (
              <tr key={`${c.provider}/${c.model}`} className="border-t border-line">
                <td className="py-1.5 font-mono text-[12px]">{c.model}</td>
                <td>{c.requests}{c.failed ? ` (${c.failed} ✗)` : ''}</td>
                <td className="text-right">{usd(c.cost_usd)}</td>
              </tr>
            ))}
            <tr className="border-t border-line font-medium">
              <td className="py-1.5">{t('matching.thisMonth')}</td><td />
              <td className="text-right">{usd(costTotal)} / {usd(Number(s?.monthly_cap_usd ?? 0))}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* Accuracy */}
      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-[18px] font-semibold">{t('matching.accuracyTitle')}</h2>
        <p className="text-[13px] text-muted">{t('matching.accuracyIntro')}</p>
        {isOwner && (
          progress ? (
            <div className="flex flex-wrap items-center gap-3 text-[13.5px]">
              <span className="tabular">{t('matching.testing', { done: progress.done, total: progress.total || '…' })}</span>
              <Button size="sm" variant="ghost" onClick={() => { stop.current = true; }}>{t('matching.stop')}</Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void runTest()}>
              <FlaskConical className="h-4 w-4" aria-hidden />
              {t('matching.runTest')}
            </Button>
          )
        )}
        {(report.data?.accuracy ?? []).length === 0 ? (
          <p className="text-[13px] text-muted">{t('matching.noTest')}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted">
              <tr>
                <th className="py-1 font-normal">{t('matching.task')}</th>
                <th className="font-normal">{t('matching.rulesCol')}</th>
                <th className="font-normal">{t('matching.aiCol')}</th>
                <th className="font-normal">{t('matching.sureCol')}</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {(report.data?.accuracy ?? []).map((a) => (
                <AccuracyRow key={a.task} a={a} />
              ))}
            </tbody>
          </table>
        )}
        {(report.data?.decisions ?? []).length > 0 && (
          <>
            <h3 className="mt-2 text-[14px] font-medium">{t('matching.decisionsTitle')}</h3>
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-muted">
                <tr><th className="py-1 font-normal">{t('matching.task')}</th><th className="font-normal">{t('matching.how')}</th><th className="font-normal">{t('matching.decided')}</th></tr>
              </thead>
              <tbody className="tabular">
                {report.data!.decisions.map((d) => (
                  <tr key={`${d.task}/${d.pattern}`} className="border-t border-line">
                    <td className="py-1.5">{t(`matching.tasks.${d.task}` as 'matching.tasks.line_product')}</td>
                    <td className="font-mono text-[11.5px] text-muted">{d.pattern}</td>
                    <td>{t('matching.decidedRow', { ok: d.accepted, changed: d.changed, no: d.rejected, open: d.pending })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      {/* Recent runs */}
      <Card className="flex flex-col gap-2">
        <h2 className="font-display text-[18px] font-semibold">{t('matching.runsTitle')}</h2>
        {(report.data?.runs ?? []).length === 0 ? (
          <p className="text-[13px] text-muted">{t('matching.noRuns')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {report.data!.runs.map((r) => (
              <li key={r.id} className="tabular flex flex-wrap gap-x-3 text-muted">
                <span className="text-text">{new Date(r.started_at).toLocaleString(membership.household.locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span>{t(`matching.trigger.${r.trigger}` as 'matching.trigger.cron')}</span>
                {r.finished_at ? (
                  <span>
                    {t('matching.runStats', {
                      suggestions: Number(r.stats.suggestions ?? r.stats.evaluated ?? 0),
                      calls: Number(r.stats.ai_calls ?? 0),
                      cost: usd(Number(r.stats.cost_usd ?? 0)),
                    })}
                  </span>
                ) : (
                  <span>{t('matching.running')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AccuracyRow({ a }: { a: Accuracy }) {
  const { t } = useTranslation();
  const ready = a.sure_n >= AUTO_AT.min && a.sure_correct / a.sure_n >= AUTO_AT.precision;
  return (
    <tr className="border-t border-line align-top">
      <td className="py-1.5">
        {t(`matching.tasks.${a.task}` as 'matching.tasks.line_product')}
        <span className="block text-[11.5px] text-muted">{t('matching.tested', { count: a.n })}</span>
      </td>
      <td>
        {pct(a.rule_correct, a.rule_answered)}
        <span className="block text-[11.5px] text-muted">{t('matching.answered', { n: a.rule_answered, of: a.n })}</span>
      </td>
      <td>
        {pct(a.ai_correct, a.ai_answered)}
        <span className="block text-[11.5px] text-muted">{t('matching.answered', { n: a.ai_answered, of: a.n })}</span>
      </td>
      <td>
        {pct(a.sure_correct, a.sure_n)}
        <span className={cn('block text-[11.5px]', ready ? 'text-teal' : 'text-muted')}>
          {ready ? t('matching.autoReady') : t('matching.autoNotYet', { n: a.sure_n })}
        </span>
      </td>
    </tr>
  );
}
