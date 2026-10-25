// Suggestions for the bank-SMS review inbox. Pure functions: the database only enforces the rules
// (one household, not reviewed twice); what an alert probably IS gets worked out here, and a person
// confirms it. Amounts are compared in cents.
//
// Phase 9a: refunds (a Seylan reversal names the charge it undoes), notes with no money of their own
// (instalment plans, statements, reminders, low ETC balance, an ETC top-up already seen as a bank
// debit), a large "Transfer Order Credit" that looks like a loan, and alerts for an account Gedara
// doesn't know yet (grouped as "new account seen").
import type { SmsKind } from '../sms/parse.ts';
import { reversedTxnId } from '../sms/parse.ts';
import { billNameNorm } from './normalise.ts';

export type { SmsKind };

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
  bank_txn_id: string | null;
  parser: string | null;
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
  institution?: string | null;
}

/** Why an alert is only a note (it adds or moves no money of its own). */
export type NoteReason = 'instalment' | 'statement' | 'reminder' | 'low_balance' | 'same_as' | 'receipt' | 'shop';

export type Suggestion =
  | { kind: 'link'; txId: string; confident: boolean; moves: boolean; others: string[] }
  | { kind: 'transfer'; from: string; to: string; total: number; fee: number; pairId: string | null; confident: boolean }
  /** memo: the text a remembered / built-in category is looked up by (the merchant, or "ETC top-up"). */
  /** evidence: the payee a confirmation SMS names for this payment ("SLT bill", "Dialog reload", "Cargills"). */
  | { kind: 'expense'; account: string | null; total: number | null; estimated: boolean; memo: string | null; evidence?: string }
  | { kind: 'income'; account: string; total: number }
  /** Money back on a card; chargeSmsId = the purchase alert it undoes, when there is one. */
  | { kind: 'refund'; account: string; total: number | null; estimated: boolean; chargeTxId: string | null; chargeSmsId: string | null; confident: boolean }
  /** A large credit that looks like a loan paid out: a transfer from the loan account, once there is one. */
  | { kind: 'loan'; account: string; total: number; loanAccount: string | null }
  | { kind: 'note'; reason: NoteReason; relatedSmsId: string | null; confident: boolean }
  | { kind: 'none' };

/** Alerts for digits no account has: "BOC ..708 — 17 alerts". */
export interface UnknownAccount {
  institution: string;
  digits: string;
  /** what the alerts say it is: card alerts → credit card, BOC Flex Tap & Pay → wallet, account alerts → bank */
  kind: 'bank' | 'credit_card' | 'wallet';
  count: number;
}

export interface Gap {
  expected: number;
  reported: number;
  /** the alert the chain last agreed with (where the gap starts; Phase 9b.2) */
  sinceSmsId?: string;
}

export interface InboxAnalysis {
  suggestions: Map<string, Suggestion>;
  gaps: Map<string, Gap>;
  /** LKR value of each alert (fx charges: from the available-balance change, when it's clean). */
  lkr: Map<string, { amount: number | null; estimated: boolean }>;
  unknownAccounts: UnknownAccount[];
}

const DAY = 86_400_000;
const PAIR_WINDOW = 36 * 60 * 60 * 1000;
const MAX_FEE = 50;
/** An ETC top-up and the bank debit that paid it arrive within minutes of each other. */
const SAME_PAYMENT_WINDOW = 15 * 60 * 1000;
/** A "Transfer Order Credit" this large is a loan paid out, not income (BOC loan, 2026-10). */
export const LOAN_AT = 500_000;
const REFUND_DAYS = 60;
const CARD_KINDS = new Set(['card_charge', 'card_payment', 'refund']);
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
    case 'refund':
      return lkr;
    default:
      return null;
  }
}

/** The alerts' own view of accounts Gedara doesn't have yet (only alerts still waiting count). */
export function unknownAccounts(sms: SmsRow[]): UnknownAccount[] {
  const groups = new Map<string, UnknownAccount>();
  for (const s of sms) {
    if (!isNew(s) || s.account_id || !s.last_digits || !s.institution || s.kind === 'info' || s.kind === 'unknown') continue;
    const key = `${s.institution}|${s.last_digits}`;
    const g = groups.get(key) ?? { institution: s.institution, digits: s.last_digits, kind: 'bank' as const, count: 0 };
    g.count += 1;
    if (CARD_KINDS.has(s.kind)) g.kind = 'credit_card';
    else if (s.parser?.startsWith('boconline.')) g.kind = 'wallet';
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ── Evidence: a payee's confirmation explains a payment (Phase 9b.1) ─────────
const RECEIPT_WINDOW = 36 * 60 * 60 * 1000;
const SHOP_WINDOW = 30 * 60 * 1000;

export interface Evidence {
  payee: string;
  /** the receipt / shop note that says so */
  fromSmsId: string;
  /** what the payment carried on top (a bank fee), in rupees */
  fee: number;
  /** a Star Points shop note names the shop only: it explains the payment but says nothing about the category */
  shopOnly?: boolean;
}

/**
 * Which payment each payee's message confirms, over ALL alerts (also ones already booked or seen):
 *   a receipt (SLT bill, LECO, Mobitel, Dialog …) ↔ a bank debit / card charge of the same amount (or up to
 *   Rs 50 more: a fee) within 36 h — or on the same / next day when the receipt has no time;
 *   a Star Points "transaction at Cargills" note ↔ a card charge within 30 minutes that names the same
 *   shop (the note is a loyalty card: the bill may have been paid in cash, so a time alone proves nothing).
 * One payment per message, the closest first.
 */
/** When an alert's money moved: its own time, else when it arrived. */
export function smsWhen(s: SmsRow): number {
  return s.occurred_at ? instant(s.occurred_on, s.occurred_at) : Date.parse(s.received_at);
}

export function paymentEvidence(sms: SmsRow[]): Map<string, Evidence> {
  const when = smsWhen;
  const payments = sms.filter((p) => (p.kind === 'bank_debit' || p.kind === 'card_charge') && p.amount !== null && p.parser !== 'boc.etc_topup');
  const pairs: Array<{ r: SmsRow; p: SmsRow; fee: number; dt: number }> = [];
  for (const r of sms) {
    if (r.kind === 'receipt' && r.amount !== null) {
      for (const p of payments) {
        const fee = cents(p.amount!) - cents(r.amount);
        if (fee < 0 || fee > MAX_FEE * 100) continue;
        const dt = r.occurred_at ? Math.abs(when(p) - when(r)) : daysApart(p.occurred_on, r.occurred_on) * DAY;
        if ((r.occurred_at && dt <= RECEIPT_WINDOW) || (!r.occurred_at && dt <= DAY)) pairs.push({ r, p, fee, dt });
      }
    } else if (r.parser === 'starpoints.shop' && r.merchant_text) {
      const shop = billNameNorm(r.merchant_text).split(' ')[0]!;
      for (const p of payments) {
        if (p.kind !== 'card_charge' || !shop || !billNameNorm(p.merchant_text).split(' ').some((w) => w.startsWith(shop))) continue;
        const dt = Math.abs(when(p) - when(r));
        if (dt <= SHOP_WINDOW) pairs.push({ r, p, fee: 0, dt });
      }
    }
  }
  pairs.sort((a, b) => Number(a.fee > 0) - Number(b.fee > 0) || a.dt - b.dt);
  const out = new Map<string, Evidence>();
  const used = new Set<string>();
  for (const { r, p, fee } of pairs) {
    if (out.has(p.id) || used.has(r.id)) continue;
    out.set(p.id, { payee: r.merchant_text!, fromSmsId: r.id, fee: fee / 100, ...(r.kind === 'receipt' ? {} : { shopOnly: true }) });
    used.add(r.id);
  }
  return out;
}

/** Bank wording that names no shop: only evidence (or a person) can say what it was for. */
export function namesNoShop(text: string | null | undefined): boolean {
  return !text || /\b(transfer (debit|credit)|transfer order|ceft|slips|atm withdrawal|no book deposit|cash deposit|standing order|dormant chg)\b/i.test(text);
}

export function analyseInbox(sms: SmsRow[], txs: TxCandidate[], linkedTxIds: Set<string>, accounts: AccountLite[]): InboxAnalysis {
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const suspense = new Set(accounts.filter((a) => a.is_suspense).map((a) => a.id));
  const cash = accounts.find((a) => a.kind === 'cash' && !a.archived)?.id ?? null;
  const bank = accounts.find((a) => a.kind === 'bank' && !a.archived && !a.is_suspense)?.id ?? null;
  const loanAccounts = accounts.filter((a) => a.kind === 'loan' && !a.archived);

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
          if (expected !== cents(s.balance_after)) gaps.set(s.id, { expected: expected / 100, reported: s.balance_after, sinceSmsId: prev.id });
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

  // ── 3. Notes: no money of their own ───────────────────────────────────────────
  const etcDebits = new Set<string>();
  const at = (s: SmsRow) => Date.parse(s.received_at);
  const evidence = paymentEvidence(sms);
  const explains = new Map([...evidence].map(([paymentId, e]) => [e.fromSmsId, paymentId]));
  for (const s of fresh) {
    if (suggestions.has(s.id)) continue;
    if (s.kind === 'receipt' || s.parser === 'starpoints.shop') {
      // A payee's confirmation: it explains the payment it matches (or waits for one).
      suggestions.set(s.id, {
        kind: 'note', reason: s.kind === 'receipt' ? 'receipt' : 'shop', relatedSmsId: explains.get(s.id) ?? null, confident: true,
      });
    } else if (s.kind === 'info') {
      const reason: NoteReason =
        s.parser === 'peoples.instalment' ? 'instalment'
        : s.parser === 'peoples.statement' ? 'statement'
        : s.parser === 'boc.etc_low' ? 'low_balance'
        : 'reminder';
      // An instalment plan converts a purchase already charged: point at it (same amount, before).
      const charge = reason === 'instalment' && s.amount !== null
        ? sms.find((c) => c.kind === 'card_charge' && c.institution === s.institution && c.amount !== null &&
            cents(c.amount) === cents(s.amount!) && at(c) <= at(s) && at(s) - at(c) <= REFUND_DAYS * DAY)
        : undefined;
      suggestions.set(s.id, { kind: 'note', reason, relatedSmsId: charge?.id ?? null, confident: true });
    } else if (s.parser === 'boc.etc_topup' && s.amount !== null) {
      // The same top-up may also arrive as a BOC "Online Transfer Debit" minutes apart: that debit is
      // the expense (Transport › tolls); this alert is then only a note on it.
      const debit = sms.find((d) => d.id !== s.id && d.kind === 'bank_debit' && d.parser !== 'boc.etc_topup' &&
        d.amount !== null && cents(d.amount) === cents(s.amount!) && Math.abs(at(d) - at(s)) <= SAME_PAYMENT_WINDOW);
      if (debit) {
        suggestions.set(s.id, { kind: 'note', reason: 'same_as', relatedSmsId: debit.id, confident: true });
        etcDebits.add(debit.id);
      }
    }
  }

  // ── 4. Everything else: an existing transaction, or a new one ─────────────────
  const available = txs.filter((t) => !linkedTxIds.has(t.id));
  for (const s of fresh) {
    if (suggestions.has(s.id)) continue; // a transfer pair or a note
    if (s.parser === 'boc.etc_topup' && s.amount !== null) {
      // Paid by internet banking from a BOC account the alert doesn't name: ask which.
      const boc = accounts.filter((a) => a.kind === 'bank' && !a.archived && !a.is_suspense && a.institution === 'BOC');
      suggestions.set(s.id, {
        kind: 'expense', account: boc.length === 1 ? boc[0]!.id : bank, total: s.amount, estimated: false, memo: 'ETC top-up',
      });
      continue;
    }
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
          if (s.kind === 'refund') return t.type === 'refund' && cents(t.total) === wanted && t.account_id === s.account_id;
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
    switch (s.kind) {
      case 'card_charge':
      case 'bank_debit':
        suggestions.set(s.id, {
          kind: 'expense', account: s.account_id, total: amount, estimated: lkr.get(s.id)?.estimated ?? false,
          memo: (evidence.get(s.id)?.shopOnly ? null : evidence.get(s.id)?.payee) ?? (etcDebits.has(s.id) ? 'ETC top-up' : s.merchant_text),
          ...(evidence.has(s.id) && !evidence.get(s.id)!.shopOnly ? { evidence: evidence.get(s.id)!.payee } : {}),
        });
        break;
      case 'bank_credit':
        if (amount !== null && amount >= LOAN_AT && /transfer order credit/i.test(s.merchant_text ?? '')) {
          suggestions.set(s.id, {
            kind: 'loan', account: s.account_id, total: amount,
            loanAccount: loanAccounts.length === 1 ? loanAccounts[0]!.id : null,
          });
          break;
        }
        suggestions.set(s.id, amount !== null ? { kind: 'income', account: s.account_id, total: amount } : { kind: 'none' });
        break;
      case 'refund': {
        // A Seylan reversal names the charge it undoes by its bank id; others: same card + amount, before.
        const original = reversedTxnId(s.bank_txn_id);
        const charge = sms.find((c) => c.kind === 'card_charge' && c.account_id === s.account_id &&
          (original
            ? c.bank_txn_id === original
            : c.amount !== null && s.amount !== null && cents(c.amount) === cents(s.amount) && c.currency === s.currency &&
              at(c) <= at(s) && at(s) - at(c) <= REFUND_DAYS * DAY));
        suggestions.set(s.id, {
          kind: 'refund', account: s.account_id, total: amount, estimated: lkr.get(s.id)?.estimated ?? false,
          chargeTxId: charge?.transaction_id ?? null, chargeSmsId: charge?.id ?? null, confident: !!charge,
        });
        break;
      }
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
  return { suggestions, gaps, lkr, unknownAccounts: unknownAccounts(sms) };
}

/** The fingerprint rpc_sms_post will use: the earliest alert's (same order as the SQL). */
export function postFingerprint(rows: Pick<SmsRow, 'received_at' | 'fingerprint'>[]): string {
  return [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.fingerprint.localeCompare(b.fingerprint))[0]!
    .fingerprint;
}

/** Signed amount as it affects the household: money out negative. */
export function smsSigned(s: Pick<SmsRow, 'kind'>, amount: number): number {
  return s.kind === 'bank_credit' || s.kind === 'card_payment' || s.kind === 'refund' ? amount : -amount;
}
