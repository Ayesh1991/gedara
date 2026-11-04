import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, CornerDownRight, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AskCall, Refusal } from '@ask/plan';
import { TargetLink } from '@/components/insights/Num';
import { Button } from '@/components/ui/button';
import { uiLocale } from '@/i18n';
import { AskError, askKey, askQuestion, runForAnswer, type AskResponse } from '@/lib/ask/queries';
import { renderAnswer, type Answer, type Line, type Val } from '@/lib/ask/render';
import { formatLKR } from '@/lib/money/format';
import { categoriesQuery } from '@/lib/money/queries';
import { formatDay, formatMonth } from '@/lib/time';
import { cn } from '@/lib/utils';

const EXAMPLES = ['fish', 'due', 'toyota', 'drill', 'runout', 'boc'] as const;
const PROVIDER = { groq: 'Groq', openai: 'OpenAI' } as const;

type Result = { call: AskCall; answer: Answer | null; failed: boolean };
type State =
  | { phase: 'idle' }
  | { phase: 'asking' }
  | { phase: 'refused'; refusal: Refusal; meta: AskResponse }
  | { phase: 'answered'; results: Result[]; meta: AskResponse }
  | { phase: 'error'; code: string; reason?: string };

// Private-use characters mark where a value goes; they can't occur in a translation.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const MARK = new RegExp(`${OPEN}(\\w+)${CLOSE}`);

/** Puts values into a translated sentence: `{{x}}` → the value, numbers in IBM Plex Mono. Plain text only. */
function useFill() {
  const { t } = useTranslation();
  return (line: Line, locale: string, year: string): ReactNode => {
    const marks: Record<string, string> = {};
    for (const k of Object.keys(line.vars ?? {})) marks[k] = `${OPEN}${k}${CLOSE}`;
    const raw = t(line.key as 'ask.title', { ...marks, ...(line.count !== undefined ? { count: line.count } : {}) }) as string;
    return raw.split(MARK).map((part, i) =>
      i % 2 === 0 ? <Fragment key={i}>{part}</Fragment> : <Value key={i} v={line.vars?.[part]} locale={locale} year={year} />,
    );
  };
}

function Value({ v, locale, year }: { v: Val | undefined; locale: string; year: string }) {
  if (!v) return null;
  if ('text' in v) return <>{v.text}</>;
  const mono = 'tabular font-mono';
  if ('money' in v) return <span className={mono}>{formatLKR(v.money)}</span>;
  if ('num' in v) return <span className={mono}>{new Intl.NumberFormat('en-LK').format(v.num)}</span>;
  if ('day' in v) return <span className={mono}>{formatDay((v as { day: string }).day, locale, year)}</span>;
  if ('month' in v) return <span className={mono}>{formatMonth((v as { month: string }).month, locale)}</span>;
  return (
    <span className={mono}>
      {new Intl.NumberFormat('en-LK', { maximumFractionDigits: 2 }).format(v.qty)}
      {v.unit ? ` ${v.unit}` : ''}
    </span>
  );
}

/**
 * Ask Gedara (Phase 10): a question box and the answer. The AI only picks which of Gedara's fixed
 * read-only questions to run; Gedara runs them with the person's own login and shows its own numbers, each
 * linking to the page it came from. Nothing is kept: leaving the screen forgets the question and answer.
 */
export function AskPanel({
  householdId,
  householdLocale,
  initial = '',
  autoAsk = false,
  onLeave,
  className,
}: {
  householdId: string;
  householdLocale: string;
  initial?: string;
  autoAsk?: boolean;
  /** called when a link in the answer is followed (e.g. to close the palette) */
  onLeave?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fill = useFill();
  const [q, setQ] = useState(initial);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const categories = useQuery(categoriesQuery(householdId));
  const asked = useRef(false);
  const locale = uiLocale(householdLocale);
  const year = String(new Date().getFullYear());

  const parentOf = (catId: string) => categories.data?.find((c) => c.id === catId)?.parent_id ?? null;

  async function ask(question: string) {
    const text = question.trim();
    if (!text || state.phase === 'asking') return;
    setState({ phase: 'asking' });
    try {
      const meta = await askQuestion(householdId, text);
      void qc.invalidateQueries({ queryKey: askKey(householdId, 'status') });
      if (meta.plan.refusal) {
        setState({ phase: 'refused', refusal: meta.plan.refusal, meta });
        return;
      }
      const results = await Promise.all(
        meta.plan.calls.map(async (call): Promise<Result> => {
          try {
            const data = await runForAnswer(householdId, call);
            return { call, answer: renderAnswer(call, data, { parentOf }), failed: false };
          } catch {
            return { call, answer: null, failed: true };
          }
        }),
      );
      setState({ phase: 'answered', results, meta });
    } catch (err) {
      setState({ phase: 'error', code: err instanceof AskError ? err.code : 'unknown', reason: err instanceof AskError ? err.reason : undefined });
    }
  }

  // Another reading of the same question: runs the database call again, no AI and not counted.
  async function rerun(index: number, call: AskCall) {
    if (state.phase !== 'answered') return;
    const results = [...state.results];
    try {
      const data = await runForAnswer(householdId, call);
      results[index] = { call, answer: renderAnswer(call, data, { parentOf }), failed: false };
    } catch {
      results[index] = { call, answer: null, failed: true };
    }
    setState({ ...state, results });
  }

  useEffect(() => {
    if (autoAsk && initial && !asked.current) {
      asked.current = true;
      void ask(initial);
    }
    // only once, for the question it was opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, initial]);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <label htmlFor="ask-q" className="sr-only">
          {t('ask.placeholder')}
        </label>
        <input
          id="ask-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={300}
          placeholder={t('ask.placeholder')}
          autoComplete="off"
          enterKeyHint="send"
          className="h-12 min-w-0 flex-1 rounded-[14px] border border-line-2 bg-white/[0.04] px-4 text-[16px] outline-none placeholder:text-faint focus:border-accent-b"
        />
        <Button type="submit" variant="primary" size="icon" disabled={!q.trim() || state.phase === 'asking'} aria-label={t('ask.ask')}>
          {state.phase === 'asking' ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <ArrowUp className="h-5 w-5" aria-hidden />}
        </Button>
      </form>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.phase === 'idle' && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">{t('ask.try')}</p>
            <ul className="flex flex-wrap gap-2">
              {EXAMPLES.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    onClick={() => {
                      const text = t(`ask.examples.${k}` as 'ask.examples.fish');
                      setQ(text);
                      void ask(text);
                    }}
                    className="rounded-full border border-line px-3 py-1.5 text-left text-[13px] text-text hover:bg-white/5"
                  >
                    {t(`ask.examples.${k}` as 'ask.examples.fish')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.phase === 'asking' && <p className="text-[14px] text-muted">{t('ask.thinking')}</p>}

        {state.phase === 'error' && (
          <p role="alert" className="rounded-2xl border border-red/30 bg-red/10 p-3 text-[14px]">
            {state.code === 'unsafe_question'
              ? t(`ask.unsafe.${state.reason === 'otp' || state.reason === 'card' || state.reason === 'code' ? state.reason : 'other'}` as 'ask.unsafe.otp')
              : t(`ask.errors.${['off', 'stopped', 'limit', 'cap', 'not_member', 'no_answer', 'network'].includes(state.code) ? state.code : 'unknown'}` as 'ask.errors.off')}
          </p>
        )}

        {state.phase === 'refused' && (
          <div className="rounded-2xl border border-line bg-white/[0.03] p-4 text-[14.5px]">
            <p>{t(`ask.refusal.${state.refusal}` as 'ask.refusal.write')}</p>
            {state.refusal === 'other' && (
              <ul className="mt-2 list-disc pl-5 text-[13px] text-muted">
                {(['spend', 'due', 'instalments', 'find', 'pantry', 'balances', 'budget', 'warranty'] as const).map((k) => (
                  <li key={k}>{t(`ask.can.${k}` as 'ask.can.spend')}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state.phase === 'answered' &&
          state.results.map((r, i) => (
            <section key={i} className="rounded-2xl border border-line bg-white/[0.03] p-4" aria-label={t('ask.answer')}>
              {!r.answer ? (
                <p className="text-[14px] text-muted">{t('ask.errors.read')}</p>
              ) : (
                <>
                  {r.answer.subject && <p className="mb-1 text-[12.5px] tracking-wide text-muted uppercase">{fill(r.answer.subject, locale, year)}</p>}
                  <p className="text-[15.5px] leading-snug">{fill(r.answer.head, locale, year)}</p>
                  {r.answer.rows.length > 0 && (
                    <ul className="mt-3 flex flex-col divide-y divide-line">
                      {r.answer.rows.map((row, j) => {
                        const inner = (
                          <span className="flex items-center gap-3 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px]">
                                <Value v={row.label} locale={locale} year={year} />
                              </span>
                              {row.detail && <span className="block text-[12.5px] text-muted">{fill(row.detail, locale, year)}</span>}
                            </span>
                            {row.value && (
                              <span className={cn('shrink-0 text-[14px]', row.tone === 'red' && 'text-red', row.tone === 'amber' && 'text-amber', row.tone === 'teal' && 'text-teal')}>
                                <Value v={row.value} locale={locale} year={year} />
                              </span>
                            )}
                          </span>
                        );
                        return (
                          <li key={j}>
                            {row.link ? (
                              <TargetLink target={row.link} className="block hover:bg-white/[0.03]" {...(onLeave ? { onClick: onLeave } : {})}>
                                {inner}
                              </TargetLink>
                            ) : (
                              inner
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {r.answer.chips.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] text-muted">{t('ask.alsoMeant')}</span>
                      {r.answer.chips.map((c, k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => void rerun(i, c.call)}
                          className="rounded-full border border-line px-2.5 py-1 text-[12.5px] hover:bg-white/5"
                        >
                          <Value v={c.label} locale={locale} year={year} />
                          <span className="text-muted"> · {t(c.kindKey as 'ask.kind.sub')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {r.answer.open && (
                    <TargetLink target={r.answer.open} className="mt-3 inline-flex items-center gap-1 text-[13px] text-accent-b" {...(onLeave ? { onClick: onLeave } : {})}>
                      <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                      {t('ask.open')}
                    </TargetLink>
                  )}
                </>
              )}
            </section>
          ))}

        {(state.phase === 'answered' || state.phase === 'refused') && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <Sparkles className="h-3.5 w-3.5 text-info" aria-hidden />
            {t('ask.answeredBy', { provider: PROVIDER[state.meta.provider], model: state.meta.model })}
            <span aria-hidden>·</span>
            <span>
              {t('ask.usedToday', { used: state.meta.used, limit: state.meta.limit })}
            </span>
          </p>
        )}
        {(state.phase === 'answered' || state.phase === 'idle') && (
          <p className="flex items-start gap-2 text-[12px] text-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal" aria-hidden />
            {t('ask.privacy')}
          </p>
        )}
      </div>
    </div>
  );
}
