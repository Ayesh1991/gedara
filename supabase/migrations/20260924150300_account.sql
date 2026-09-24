-- Phase 2 · 14 — accounts (MASTER_PLAN §3.6)
-- Where money sits: cash, the BOC savings account, credit cards. Balances are never stored — they
-- are computed from transactions (v_account_balance, migration 17):
--   balance = opening_balance (at the END of opening_on) + effects of transactions after opening_on.
-- Credit cards carry a negative balance = amount owed; available credit = credit_limit + balance.
-- `is_suspense` marks the "Card — to be matched" bucket: ledger rows that only say "card" wait there
-- until they're moved to the right card (by hand now, by SMS matching in Phase 2b).

create table public.account (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.household (id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 60),
  kind            text not null check (kind in ('cash', 'bank', 'credit_card', 'wallet', 'loan', 'investment')),
  institution     text check (length(institution) <= 40),     -- 'BOC', 'Seylan' — Phase 2b maps SMS senders
  last4           text check (last4 ~ '^[0-9]{3,4}$'),         -- as printed in bank alerts (BOC a/c shows 3)
  credit_limit    numeric(14,2) check (credit_limit >= 0),
  opening_balance numeric(14,2) not null default 0,
  opening_on      date,                                        -- null = balance not set up yet (the app asks)
  is_suspense     boolean not null default false,
  currency        text not null default 'LKR' check (currency ~ '^[A-Z]{3}$'),
  color           text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort            integer not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (household_id, id),
  check (credit_limit is null or kind in ('credit_card', 'loan'))
);

create unique index account_name_idx on public.account (household_id, lower(btrim(name)));

create trigger account_updated_at
  before update on public.account
  for each row execute function private.set_updated_at();

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.account enable row level security;

revoke all on table public.account from anon, authenticated;
grant select, delete on table public.account to authenticated;
grant insert (household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on,
              currency, color, sort)
  on table public.account to authenticated;
-- Opening balance/date are account setup; later corrections are `adjustment` transactions.
grant update (name, institution, last4, credit_limit, opening_balance, opening_on, color, sort, archived)
  on table public.account to authenticated;

create policy account_select on public.account
  for select to authenticated
  using (private.is_member(household_id));

create policy account_insert on public.account
  for insert to authenticated
  with check (private.can_write(household_id));

create policy account_update on public.account
  for update to authenticated
  using (private.can_write(household_id))
  with check (private.can_write(household_id));

create policy account_delete on public.account
  for delete to authenticated
  using (private.can_write(household_id));

-- ── Seed: the Gedara household's accounts (2026-09-24) ───────────────────────
do $$
declare
  v_household uuid;
begin
  select id into v_household from public.household where name = 'Gedara' order by created_at limit 1;
  if v_household is null then
    return;
  end if;

  insert into public.account
    (household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on, is_suspense, color, sort)
  values
    (v_household, 'Cash',                 'cash',        null,      null,   null,    0,       null,         false, '#2FC6A0', 1),
    (v_household, 'BOC Savings',          'bank',        'BOC',     '319',  null,    6443.81, '2026-09-24', false, '#F5B83D', 2),
    (v_household, 'BOC Credit Card',      'credit_card', 'BOC',     '8873', 250000,  0,       null,         false, '#FFB35C', 3),
    (v_household, 'Seylan Credit Card',   'credit_card', 'Seylan',  '6029', 100000,  0,       null,         false, '#FF8FA3', 4),
    (v_household, 'Sampath Credit Card',  'credit_card', 'Sampath', '6577', 300000,  0,       null,         false, '#7FB5FF', 5),
    (v_household, 'People''s Credit Card','credit_card', 'People''s','1913', 1000000, 0,       null,         false, '#C99BFF', 6),
    (v_household, 'Card — to be matched', 'credit_card', null,      null,   null,    0,       null,         true,  '#A0AAB8', 7)
  on conflict do nothing;
end;
$$;

update public.app_meta set value = '14' where key = 'schema_version';
