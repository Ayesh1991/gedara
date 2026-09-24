import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { manualFingerprint } from '@/lib/money/fingerprint';
import { formatLKR, parseAmount, toCents } from '@/lib/money/format';
import {
  ACCOUNT_KINDS,
  createAccount,
  invalidateMoney,
  moneyErrorKey,
  saveTransaction,
  updateAccount,
  type Account,
  type AccountKind,
} from '@/lib/money/queries';
import { timeNowIn, todayIn } from '@/lib/time';
import { fieldLabel, selectClass } from './bits';

const hasLimit = (kind: string) => kind === 'credit_card' || kind === 'loan';

/** Add or edit an account: name, kind, bank, last digits, credit limit (≤ 5 fields). */
export function AccountForm({
  open,
  onClose,
  householdId,
  account,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  account?: Account | null;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t(account ? 'money.accounts.editTitle' : 'money.accounts.addTitle')}>
      <AccountFormBody onClose={onClose} householdId={householdId} account={account} />
    </Sheet>
  );
}

function AccountFormBody({ onClose, householdId, account }: { onClose: () => void; householdId: string; account?: Account | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<AccountKind>((account?.kind as AccountKind | undefined) ?? 'credit_card');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [last4, setLast4] = useState(account?.last4 ?? '');
  const [limit, setLimit] = useState(account?.credit_limit != null ? String(account.credit_limit) : '');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    const creditLimit = hasLimit(kind) && limit.trim() ? parseAmount(limit) : null;
    if (hasLimit(kind) && limit.trim() && creditLimit === null) {
      toast.error(t('money.form.needAmount'));
      return;
    }
    setBusy(true);
    try {
      const input = {
        name: name.trim(),
        institution: institution.trim() || null,
        last4: last4.trim() || null,
        credit_limit: creditLimit,
      };
      if (account) await updateAccount(account.id, input);
      else await createAccount(householdId, { ...input, kind });
      await invalidateMoney(qc, householdId);
      toast.success(t('money.accounts.saved', { name: input.name }));
      onClose();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!account) return;
    setBusy(true);
    try {
      await updateAccount(account.id, { archived: !account.archived });
      await invalidateMoney(qc, householdId);
      onClose();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="acc-name" className={fieldLabel}>
          {t('money.accounts.name')}
        </label>
        <Input id="acc-name" autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {!account && (
        <div>
          <label htmlFor="acc-kind" className={fieldLabel}>
            {t('money.accounts.kind')}
          </label>
          <select id="acc-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`money.kinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <div>
          <label htmlFor="acc-bank" className={fieldLabel}>
            {t('money.accounts.institution')}
          </label>
          <Input id="acc-bank" maxLength={40} value={institution} onChange={(e) => setInstitution(e.target.value)} />
        </div>
        <div>
          <label htmlFor="acc-last4" className={fieldLabel}>
            {t('money.accounts.last4')}
          </label>
          <Input
            id="acc-last4"
            inputMode="numeric"
            pattern="[0-9]{3,4}"
            maxLength={4}
            className="tabular"
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>
      {hasLimit(account?.kind ?? kind) && (
        <div>
          <label htmlFor="acc-limit" className={fieldLabel}>
            {t('money.accounts.limit')}
          </label>
          <Input id="acc-limit" inputMode="decimal" className="tabular" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {t('money.accounts.save')}
      </Button>
      {account && !account.is_suspense && (
        <Button variant="ghost" disabled={busy} onClick={() => void toggleArchive()}>
          {t(account.archived ? 'money.accounts.unarchive' : 'money.accounts.archive')}
        </Button>
      )}
    </form>
  );
}

/**
 * "Set starting balance" (account setup: balance at the end of a day) or "Reconcile" (the real
 * balance differs from ours → an adjustment transaction; balances are never edited directly).
 * Cards are entered as the SMS shows them — available credit — and owed = limit − available.
 */
export function BalanceForm({
  open,
  onClose,
  householdId,
  timezone,
  account,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  timezone: string;
  account: Account;
  mode: 'opening' | 'reconcile';
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onClose} title={t(mode === 'opening' ? 'money.balance.openingTitle' : 'money.balance.reconcileTitle')}>
      <BalanceBody onClose={onClose} householdId={householdId} timezone={timezone} account={account} mode={mode} />
    </Sheet>
  );
}

function BalanceBody({
  onClose,
  householdId,
  timezone,
  account,
  mode,
}: {
  onClose: () => void;
  householdId: string;
  timezone: string;
  account: Account;
  mode: 'opening' | 'reconcile';
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isCard = hasLimit(account.kind);
  const byAvailable = isCard && account.credit_limit != null;
  const [value, setValue] = useState('');
  const [date, setDate] = useState(account.opening_on ?? todayIn(timezone));
  const [busy, setBusy] = useState(false);

  const entered = parseAmount(value);
  // Our sign convention: a card's balance is negative when money is owed.
  const target =
    entered === null ? null : byAvailable ? entered - (account.credit_limit ?? 0) : isCard ? -Math.abs(entered) : entered;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || target === null) return;
    setBusy(true);
    try {
      if (mode === 'opening') {
        await updateAccount(account.id, { opening_balance: target, opening_on: date });
      } else {
        const diff = (toCents(target) - toCents(account.balance)) / 100;
        if (diff === 0) {
          toast.success(t('money.balance.alreadyRight'));
          onClose();
          return;
        }
        const today = todayIn(timezone);
        const time = timeNowIn(timezone);
        for (let repeat = 1; repeat < 20; repeat++) {
          try {
            await saveTransaction({
              household_id: householdId,
              type: 'adjustment',
              account_id: account.id,
              payee_text: t('money.balance.correction'),
              occurred_on: today,
              occurred_at: time,
              total: diff,
              fingerprint: manualFingerprint({ type: 'adjustment', date: today, time, accountId: account.id, total: diff }, repeat),
              lines: [],
            });
            break;
          } catch (err) {
            if (moneyErrorKey(err) !== 'duplicate') throw err;
          }
        }
      }
      await invalidateMoney(qc, householdId);
      toast.success(t('money.balance.saved'));
      onClose();
    } catch (err) {
      toast.error(t(`money.errors.${moneyErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-[14px] leading-relaxed text-[#a5b0d0]">
        {t(mode === 'opening' ? 'money.balance.openingHelp' : 'money.balance.reconcileHelp')}
      </p>
      <div>
        <label htmlFor="bal-value" className={fieldLabel}>
          {t(byAvailable ? 'money.balance.available' : isCard ? 'money.balance.owed' : 'money.balance.balance')}
        </label>
        <Input
          id="bal-value"
          autoFocus
          required
          inputMode="decimal"
          className="tabular h-14 text-[22px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {byAvailable && target !== null && (
          <p className="tabular mt-1.5 text-[13px] text-muted">
            {t('money.balance.owedPreview', { owed: formatLKR(Math.max(0, -target)), limit: formatLKR(account.credit_limit ?? 0) })}
          </p>
        )}
      </div>
      {mode === 'opening' && (
        <div>
          <label htmlFor="bal-date" className={fieldLabel}>
            {t('money.balance.asAtEndOf')}
          </label>
          <Input id="bal-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      )}
      {mode === 'reconcile' && target !== null && (
        <p className="tabular text-[13.5px] text-muted">
          {t('money.balance.difference', { amount: formatLKR((toCents(target) - toCents(account.balance)) / 100) })}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || target === null}>
        {t('money.balance.save')}
      </Button>
    </form>
  );
}
