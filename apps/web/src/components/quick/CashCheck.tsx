// The gentle cash check (Phase 12): at most once a week, after five or more cash entries, one quiet
// line under Today: "Cash should be Rs 3,200. Right?". Yes is one tap. No asks what is really in
// the wallet and books the difference as an ordinary balance adjustment (rule 1: a transaction,
// never an edited balance). Never a pop-up; it can be switched off in Edit tiles.
import { manualFingerprint } from '@scan/fingerprint';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Json } from '@/lib/db.types';
import { formatLKR, parseAmount, toCents } from '@/lib/money/format';
import { localStamp } from '@/lib/quick/entry';
import { cashCheckDue } from '@/lib/quick/merge';
import { updatePrefs, type QuickState } from '@/lib/quick/state';
import { supabase } from '@/lib/supabase';
import { todayIn } from '@/lib/time';
import type { Identity } from './useQuick';

export function CashCheck({
  identity, state, online, walletName, onDone, onRefresh,
}: {
  identity: Identity;
  state: QuickState;
  online: boolean;
  walletName: string;
  onDone: (fn: (s: QuickState) => QuickState) => void;
  onRefresh: () => unknown;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [have, setHave] = useState('');
  const [busy, setBusy] = useState(false);
  const today = todayIn(identity.timezone);
  if (!online || !cashCheckDue(state, today) || state.balance === null || !state.prefs?.cash_account_id) return null;
  const expected = state.balance;
  const account = state.prefs.cash_account_id;

  async function checked() {
    await updatePrefs(identity.householdId, identity.userId, { cash_checked_on: today });
    onDone((s) => ({ ...s, since_check: 0, prefs: s.prefs ? { ...s.prefs, cash_checked_on: today } : s.prefs }));
  }

  async function yes() {
    setBusy(true);
    try {
      await checked();
      toast.success(t('quick.check.thanks'));
    } catch {
      toast.error(t('quick.check.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    const actual = parseAmount(have);
    if (actual === null || actual < 0) return;
    const diff = (toCents(actual) - toCents(expected)) / 100;
    setBusy(true);
    try {
      if (diff !== 0) {
        const { date, time } = localStamp(identity.timezone, new Date());
        let done = false;
        for (let repeat = 1; repeat < 20 && !done; repeat++) {
          const { error } = await supabase.rpc('rpc_save_transaction', {
            p: {
              household_id: identity.householdId, type: 'adjustment', account_id: account, payee_text: t('quick.check.correction'),
              occurred_on: date, occurred_at: time, total: diff, lines: [],
              fingerprint: manualFingerprint({ type: 'adjustment', date, time, accountId: account, total: diff }, repeat),
            } as unknown as Json,
          });
          if (!error) done = true;
          else if (error.code !== 'GDDUP') throw error;
        }
      }
      await checked();
      onDone((s) => ({ ...s, balance: actual }));
      toast.success(t('quick.check.fixed', { amount: formatLKR(actual, { whole: true }) }));
      void onRefresh();
    } catch {
      toast.error(t('quick.check.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass flex flex-col gap-3 rounded-[var(--r)] p-4" data-testid="quick-cash-check">
      <p className="text-[14px]">
        {t('quick.check.ask', { wallet: walletName })} <span className="tabular font-mono font-semibold">{formatLKR(expected, { whole: true })}</span>
        {t('quick.check.right')}
      </p>
      {asking ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void correct();
          }}
        >
          <Input
            inputMode="decimal"
            autoFocus
            aria-label={t('quick.check.have')}
            placeholder={t('quick.check.have')}
            value={have}
            onChange={(e) => setHave(e.target.value)}
            className="tabular flex-1 font-mono"
          />
          <Button type="submit" disabled={busy || parseAmount(have) === null}>
            {t('common.save')}
          </Button>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" disabled={busy} onClick={() => void yes()}>
            {t('quick.check.yes')}
          </Button>
          <Button size="sm" variant="ghost" className="flex-1" disabled={busy} onClick={() => setAsking(true)}>
            {t('quick.check.no')}
          </Button>
        </div>
      )}
    </div>
  );
}
