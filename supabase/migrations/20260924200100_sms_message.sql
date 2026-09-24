-- Phase 2b · 19 — the bank-SMS review inbox
-- Every bank / card alert that survives the filters (allow-listed sender, no OTP, no promo) lands
-- here, parsed by the sms-ingest Edge Function. Nothing reaches the ledger until someone reviews it:
-- a row is linked to an existing transaction, turned into a new one (source 'sms'), or ignored.
--
-- There is no stored status. A row is
--   ignored  when ignored = true
--   done     when transaction_id is set (deleting the transaction sets it back to null → new again)
--   new      otherwise
--
-- fingerprint = 's' + djb2(sender|body|received minute) (CLAUDE.md rule 5). The RPCs also treat the
-- same sender + body within 24 h as a duplicate: the live forwarder and a later SMS-backup file can
-- stamp the same message a few seconds apart.
-- Clients can only read; all writes go through the RPCs in migration 20.

create table public.sms_message (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  device_id      uuid,                                   -- null for SMS-backup imports
  channel        text not null check (channel in ('forwarder', 'backup')),
  sender         text not null check (length(btrim(sender)) between 1 and 40),
  received_at    timestamptz not null,
  body           text not null check (length(body) between 1 and 1000),
  fingerprint    text not null check (fingerprint ~ '^s[0-9a-z]{1,16}$'),
  parser         text check (length(parser) <= 40),      -- e.g. 'boc.transfer_debit'
  parser_version integer,
  kind           text not null
                 check (kind in ('card_charge', 'card_payment', 'bank_debit', 'bank_credit', 'atm', 'unknown')),
  institution    text check (length(institution) <= 40), -- 'BOC', 'Sampath', 'People''s', 'Seylan'
  last_digits    text check (last_digits ~ '^[0-9]{3,4}$'),
  account_id     uuid,                                   -- institution + last digits → account
  amount         numeric(14,2) check (amount >= 0),      -- in `currency`, as printed
  currency       text not null default 'LKR' check (currency ~ '^[A-Z]{3}$'),
  balance_after  numeric(14,2),                          -- bank: balance available · card: available credit
  merchant_text  text check (length(merchant_text) <= 120),
  bank_txn_id    text check (length(bank_txn_id) <= 40), -- Seylan prints one
  occurred_on    date not null,                          -- Asia/Colombo; from the text when it has a date
  occurred_at    time(0),
  transaction_id uuid,
  ignored        boolean not null default false,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, fingerprint),
  foreign key (household_id, device_id) references public.sms_device (household_id, id)
    on delete set null (device_id),
  foreign key (household_id, account_id) references public.account (household_id, id)
    on delete set null (account_id),
  foreign key (household_id, transaction_id) references public.money_transaction (household_id, id)
    on delete set null (transaction_id),
  check (kind = 'unknown' or amount is not null),
  check (not (ignored and transaction_id is not null))
);

create unique index sms_message_bank_txn_idx on public.sms_message (household_id, sender, bank_txn_id)
  where bank_txn_id is not null;
create index sms_message_received_idx on public.sms_message (household_id, received_at desc);
create index sms_message_account_idx on public.sms_message (household_id, account_id, received_at)
  where account_id is not null;
create index sms_message_transaction_idx on public.sms_message (household_id, transaction_id)
  where transaction_id is not null;
create index sms_message_dedupe_idx on public.sms_message (household_id, sender, received_at);
create index sms_message_device_idx on public.sms_message (household_id, device_id) where device_id is not null;
create index sms_message_reviewed_by_idx on public.sms_message (reviewed_by) where reviewed_by is not null;

-- ── RLS + privileges: read-only to clients ────────────────────────────────────
alter table public.sms_message enable row level security;

revoke all on table public.sms_message from anon, authenticated;
grant select on table public.sms_message to authenticated;

create policy sms_message_select on public.sms_message
  for select to authenticated
  using (private.is_member(household_id));

-- The inbox refreshes live when the phone forwards an alert (Realtime respects the policy above).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sms_message;
  end if;
end;
$$;

update public.app_meta set value = '19' where key = 'schema_version';
