-- Phase 2 · 15 — transactions + lines (MASTER_PLAN §3.6): "every rupee lives in transaction_line"
-- A money_transaction is the bill / payslip / transfer header; its lines carry the amounts and
-- categories. Expense, income and refund headers always have lines that add up to `total`;
-- transfers and balance adjustments have none.
--
-- Fingerprints (CLAUDE.md rule 5) are deterministic and unique per household:
--   scanned bill   b<djb2>                 lines b<djb2>-<idx>-<djb2(name|amount)>   (ledger v7 format)
--   Sheet legacy   L<djb2(sorted row ids)> lines = the Sheet row id, unchanged
--   manual entry   m<djb2(type|date|time|account|payee|total)>[~n]  lines as for bills
-- Clients can only read these tables; every write goes through the RPCs in migration 16.

create table public.money_transaction (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.household (id) on delete cascade,
  type          text not null check (type in ('expense', 'income', 'transfer', 'refund', 'adjustment')),
  account_id    uuid not null,
  to_account_id uuid,
  merchant_id   uuid,
  payee_text    text check (length(payee_text) <= 120),
  occurred_on   date not null,
  occurred_at   time(0),                                   -- local (household timezone) time of day
  invoice_no    text check (length(invoice_no) <= 60),
  subtotal      numeric(14,2),
  discount      numeric(14,2) not null default 0,
  total         numeric(14,2) not null,
  source        text not null default 'manual'
                check (source in ('manual', 'scan', 'recurring', 'import_sheet', 'import_grocy', 'sms')),
  fingerprint   text not null check (fingerprint ~ '^[A-Za-z0-9][A-Za-z0-9~_-]{1,127}$'),
  related_id    uuid,                                      -- a transfer's fee expense points at the transfer
  notes         text check (length(notes) <= 2000),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, fingerprint),
  -- Accounts: NO ACTION, so an account with history can't be deleted (archive it instead).
  foreign key (household_id, account_id) references public.account (household_id, id),
  foreign key (household_id, to_account_id) references public.account (household_id, id),
  foreign key (household_id, merchant_id) references public.merchant (household_id, id)
    on delete set null (merchant_id),
  foreign key (household_id, related_id) references public.money_transaction (household_id, id)
    on delete set null (related_id),
  check ((type = 'transfer') = (to_account_id is not null)),
  check (to_account_id is distinct from account_id),
  check (type = 'adjustment' or total >= 0)
);

create index money_transaction_date_idx on public.money_transaction (household_id, occurred_on desc, occurred_at desc);
create index money_transaction_account_idx on public.money_transaction (household_id, account_id);
create index money_transaction_to_account_idx on public.money_transaction (household_id, to_account_id)
  where to_account_id is not null;
create index money_transaction_merchant_idx on public.money_transaction (household_id, merchant_id)
  where merchant_id is not null;
create index money_transaction_related_idx on public.money_transaction (household_id, related_id)
  where related_id is not null;
create index money_transaction_created_by_idx on public.money_transaction (created_by);

create table public.transaction_line (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  transaction_id uuid not null,
  line_no        integer not null check (line_no >= 0),   -- 0-based, = the ledger v7 line index
  raw_name       text not null check (length(btrim(raw_name)) between 1 and 200),
  category_id    uuid,
  qty            numeric(14,4),
  unit_id        uuid references public.unit (id),
  unit_text      text check (length(unit_text) <= 24),     -- as written on the bill / Sheet
  unit_price     numeric(14,2),
  amount         numeric(14,2) not null,                   -- negative for discounts / returned items
  base_qty       numeric(14,4),                            -- qty in the unit's base (g / ml / pcs …)
  price_per_base numeric(14,4),                            -- Rs per base unit (rule 4)
  destiny        text check (destiny in ('stock', 'asset', 'expense')),
  fingerprint    text not null check (fingerprint ~ '^[A-Za-z0-9][A-Za-z0-9~_-]{1,159}$'),
  unique (household_id, fingerprint),
  unique (transaction_id, line_no),
  foreign key (household_id, transaction_id) references public.money_transaction (household_id, id)
    on delete cascade,
  -- NO ACTION: a category in use can be archived, not deleted.
  foreign key (household_id, category_id) references public.category (household_id, id)
);

create index transaction_line_tx_idx on public.transaction_line (household_id, transaction_id);
create index transaction_line_category_idx on public.transaction_line (household_id, category_id);
create index transaction_line_unit_idx on public.transaction_line (unit_id) where unit_id is not null;

create trigger money_transaction_updated_at
  before update on public.money_transaction
  for each row execute function private.set_updated_at();

-- Receipts attached to a transaction go when it goes (same as places, migration 8).
create function private.money_transaction_delete_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attachment a
   where a.entity_type = 'transaction' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger money_transaction_delete_attachments
  after delete on public.money_transaction
  for each row execute function private.money_transaction_delete_attachments();

-- ── RLS + privileges: read-only to clients ────────────────────────────────────
alter table public.money_transaction enable row level security;
alter table public.transaction_line enable row level security;

revoke all on table public.money_transaction from anon, authenticated;
revoke all on table public.transaction_line from anon, authenticated;
grant select on table public.money_transaction to authenticated;
grant select on table public.transaction_line to authenticated;

create policy money_transaction_select on public.money_transaction
  for select to authenticated
  using (private.is_member(household_id));

create policy transaction_line_select on public.transaction_line
  for select to authenticated
  using (private.is_member(household_id));

update public.app_meta set value = '15' where key = 'schema_version';
