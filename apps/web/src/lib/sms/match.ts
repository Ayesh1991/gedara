// Suggestions for the bank-SMS review inbox. Pure functions: the database only enforces the rules
// (one household, not reviewed twice); what an alert probably IS gets worked out here, and a person
// confirms it. Amounts are compared in cents.

export type SmsKind = 'card_charge' | 'card_payment' | 'bank_debit' | 'bank_credit' | 'atm' | 'unknown';

export interface SmsRow {
  id: string;
  sender: string;
  body: string;
  received_at: string;
  fingerprint: string;
  kind: SmsKind | string;
  institution: string | null;
  last_digits: string | null;
  account_id: string | null;
  amount: number | null;
  currency: string;
  balance_after: number | null;
  merchant_text: string | null;
  occurred_on: string;
  occurred_at: string | null;
  transaction_id: string | null;
  ignored: boolean;
}

export interface TxCandidate {
  id: string;
  type: string;
  account_id: string;
  to_account_id: string | null;
  payee_text: string | null;
  occurred_on: string;
  occurred_at: string | null;
  total: number;
}

export interface AccountLite {
  id: string;
  kind: string;
  is_suspense: boolean;
  archived: boolean;
  credit_limit: number | null;
}

export type Suggestion =
  | { kind: 'link'; txId: string; confident: boolean; moves: boolean; others: string[] }
  | { kind: 'transfer'; from: string; to: string; total: number; fee: number; pairId: string | null; confident: boolean }
  | { kind: 'expense'; account: string; total: number | null; estimated: boolean }
  | { kind: 'income'; account: string; total: number }
  | { kind: 'none' };

export interface Gap {
  expected: number;
  reported: number;
}

export interface InboxAnalysis {
  suggestions: Map<string, Suggestion>;
  gaps: Map<string, Gap>;
  /** LKR value of each alert (fx charges: from the available-balance change, when it's clean). */
  lkr: Map<string, { amount: number | null; estimated: boolean }>;
}

const DAY = 86_400_000;
const PAIR_WINDOW = 36 * 60 * 60 * 1000;
const MAX_FEE = 50;
const cents = (n: number) => Math.round(n * 100);
const isNew = (s: SmsRow) => !s.ignored && !s.transaction_id;

/** Colombo wall-clock instant of a date + optional time (for ordering / distances only). */
function instant(date: string, time: string | null): number {
  return Date.parse(`${date}T${time ?? '12:00:00'}+05:30`);
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

/** How an alert moves its account's reported balance (bank: balance; card: available credit). */
function balanceEffect(s: SmsRow, lkr: number | null): number | null {
  if (lkr === null) return null;
  switch (s.kind) {
    case 'bank_debit':
    case 'atm':
    case 'card_charge':
      return -lkr;
    case 'bank_credit':
    case 'card_payment':
      return lkr;
    default:
      return null;
  }
}

export function analyseInbox(sms: SmsRow[], txs: TxCandidate[], linkedTxIds: Set<string>, accounts: AccountLite[]): InboxAnalysis {
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const suspense = new Set(accounts.filter((a) => a.is_suspense).map((a) => a.id));
  const cash = accounts.find((a) => a.kind === 'cash' && !a.archived)?.id ?? null;
  const bank = accounts.find((a) => a.kind === 'bank' && !a.archived && !a.is_suspense)?.id ?? null;

  // ── 1. LKR amounts + balance chain, per account, oldest first ─────────────────
  const lkr = new Map<string, { amount: number | null; estimated: boolean }>();
  const gaps = new Map<string, Gap>();
  const byAccount = new Map<string, SmsRow[]>();
  for (const s of sms) {
    if (s.currency === 'LKR') lkr.set(s.id, { amount: s.amount, estimated: false });
    if (s.account_id) byAccount.set(s.account_id, [...(byAccount.get(s.account_id) ?? []), s]);
  }
  for (const list of byAccount.values()) {
    list.sort((a, b) => a.received_at.localeCompare(b.received_at));
    let prev: SmsRow | null = null;
    for (const s of list) {
      if (s.balance_after === null) {
        if (s.currency !== 'LKR') lkr.set(s.id, { amount: null, estimated: false });
        continue; // no balance (e.g. People's payment): the chain carries on from the last one
      }
      if (s.currency !== 'LKR') {
        // Foreign-currency charge: the drop in available credit is what it cost in rupees.
        const delta = prev?.balance_after != null ? cents(prev.balance_after) - cents(s.balance_after) : null;
        const rate = delta !== null && s.amount ? delta / 100 / s.amount : null;
        const ok = delta !== null && delta > 0 && rate !== null && rate > 20 && rate < 2000;
        lkr.set(s.id, { amount: ok ? delta / 100 : null, estimated: ok });
      } else if (prev?.balance_after != null) {
        const effect = balanceEffect(s, s.amount);
        if (effect !== null) {
          const expected = cents(prev.balance_after) + cents(effect);
          if (expected !== cents(s.balance_after)) gaps.set(s.id, { expected: expected / 100, reported: s.balance_after });
        }
      }
      prev = s.kind === 'unknown' ? null : s; // an unknown alert breaks the chain rather than faking a gap
    }
  }
  const lkrOf = (s: SmsRow) => lkr.get(s.id)?.amount ?? null;

  // ── 2. Transfer pairs: bank debit ↔ card payment within 36 h, fee 0–50 ────────
  const suggestions = new Map<string, Suggestion>();
  const fresh = sms.filter(isNew);
  const debits = fresh.filter((s) => s.kind === 'bank_debit' && s.account_id && s.amount !== null);
  const payments = fresh.filter((s) => s.kind === 'card_payment' && s.account_id && s.amount !== null);
  const pairs: Array<{ d: SmsRow; p: SmsRow; apart: number }> = [];
  for (const d of debits) {
    for (const p of payments) {
      const fee = cents(d.amount!) - cents(p.amount!);
      const apart = Math.abs(Date.parse(d.received_at) - Date.parse(p.received_at));
      if (fee >= 0 && fee <= MAX_FEE * 100 && apart <= PAIR_WINDOW && d.account_id !== p.account_id) {
        pairs.push({ d, p, apart });
      }
    }
  }
  pairs.sort((a, b) => a.apart - b.apart);
  const paired = new Set<string>();
  for (const { d, p } of pairs) {
    if (paired.has(d.id) || paired.has(p.id)) continue;
    paired.add(d.id);
    paired.add(p.id);
    const t: Suggestion = {
      kind: 'transfer', from: d.account_id!, to: p.account_id!, total: p.amount!,
      fee: (cents(d.amount!) - cents(p.amount!)) / 100, pairId: null, confident: true,
    };
    suggestions.set(d.id, { ...t, pairId: p.id });
    suggestions.set(p.id, { ...t, pairId: d.id });
  }

  // ── 3. Everything else: an existing transaction, or a new one ─────────────────
  const available = txs.filter((t) => !linkedTxIds.has(t.id));
  for (const s of fresh) {
    if (!s.account_id || s.kind === 'unknown') {
      suggestions.set(s.id, { kind: 'none' });
      continue;
    }
    const amount = lkrOf(s);
    const when = instant(s.occurred_on, s.occurred_at);

    // Already in the ledger? (a scanned bill, a Sheet row, a transfer typed in by hand)
    if (amount !== null) {
      const wanted = cents(amount);
      const hits = available
        .filter((t) => daysApart(t.occurred_on, s.occurred_on) <= 2)
        .filter((t) => {
          if (s.kind === 'card_charge') {
            return t.type === 'expense' && cents(t.total) === wanted && (t.account_id === s.account_id || suspense.has(t.account_id));
          }
          if (s.kind === 'bank_credit') return t.type === 'income' && cents(t.total) === wanted && t.account_id === s.account_id;
          if (s.kind === 'card_payment') return t.type === 'transfer' && t.to_account_id === s.account_id && cents(t.total) === wanted;
          if (s.kind === 'atm') return t.type === 'transfer' && t.account_id === s.account_id && cents(t.total) === wanted;
          // bank_debit: a transfer out (the fee may be booked separately) or an expense of that amount
          const diff = wanted - cents(t.total);
          return t.account_id === s.account_id &&
            ((t.type === 'transfer' && diff >= 0 && diff <= MAX_FEE * 100) || (t.type === 'expense' && diff === 0));
        })
        .map((t) => ({ t, score: Math.abs(instant(t.occurred_on, t.occurred_at) - when) }))
        .sort((a, b) => a.score - b.score);
      if (hits.length) {
        const best = hits[0]!;
        const clear = hits.length === 1 || hits[1]!.score - best.score >= DAY / 2;
        const bestAcct = acct.get(best.t.account_id);
        suggestions.set(s.id, {
          kind: 'link', txId: best.t.id, confident: clear && daysApart(best.t.occurred_on, s.occurred_on) <= 1,
          moves: !!bestAcct?.is_suspense && s.kind === 'card_charge', others: hits.slice(1, 4).map((h) => h.t.id),
        });
        continue;
      }
    }
    if (suggestions.has(s.id)) continue; // part of a transfer pair

    switch (s.kind) {
      case 'card_charge':
      case 'bank_debit':
        suggestions.set(s.id, { kind: 'expense', account: s.account_id, total: amount, estimated: lkr.get(s.id)?.estimated ?? false });
        break;
      case 'bank_credit':
        suggestions.set(s.id, amount !== null ? { kind: 'income', account: s.account_id, total: amount } : { kind: 'none' });
        break;
      case 'atm':
        suggestions.set(
          s.id,
          cash && amount !== null
            ? { kind: 'transfer', from: s.account_id, to: cash, total: amount, fee: 0, pairId: null, confident: true }
            : { kind: 'none' },
        );
        break;
      case 'card_payment':
        // Paid from somewhere we have no alert for: most likely the BOC account — ask, don't assume.
        suggestions.set(
          s.id,
          bank && amount !== null && bank !== s.account_id
            ? { kind: 'transfer', from: bank, to: s.account_id, total: amount, fee: 0, pairId: null, confident: false }
            : { kind: 'none' },
        );
        break;
      default:
        suggestions.set(s.id, { kind: 'none' });
    }
  }
  return { suggestions, gaps, lkr };
}

/** The fingerprint rpc_sms_post will use: the earliest alert's (same order as the SQL). */
export function postFingerprint(rows: Pick<SmsRow, 'received_at' | 'fingerprint'>[]): string {
  return [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.fingerprint.localeCompare(b.fingerprint))[0]!
    .fingerprint;
}

/** Signed amount as it affects the household: money out negative. */
export function smsSigned(s: Pick<SmsRow, 'kind'>, amount: number): number {
  return s.kind === 'bank_credit' || s.kind === 'card_payment' ? amount : -amount;
}
