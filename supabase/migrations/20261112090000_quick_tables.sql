-- Phase 12 · 111 — Quick spend: tiles, per-person settings, the "counted once" record
--
-- Quick spend enters a small cash expense in one tap, also with no signal. Three tables:
--   quick_tile   each person's own tiles (Three-wheeler, Bus, Tea …): label, category, usual amount.
--   quick_prefs  each person's settings: the cash wallet they pay from, tile order, cash check.
--   quick_entry  one row per entry id chosen on the phone when the tile was tapped, so a resend
--                (retry after a timeout, replay after a reload, two tabs) is counted once — the
--                same pattern as stock_op (migration 50). Also feeds "today" and tile learning.
-- The money itself is an ordinary money_transaction written by rpc_quick_spend (migration 112)
-- through private.save_transaction (CLAUDE.md rule 1). Nothing here holds a balance.

create table public.quick_tile (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Starter tiles carry a key; their name comes from the app's translations until renamed.
  key          text check (key ~ '^[a-z][a-z0-9_]{1,23}$'),
  label        text check (length(btrim(label)) between 1 and 24),
  icon         text check (length(icon) <= 16),
  -- expense: paid from the wallet · handover: cash given to the other person's wallet (a transfer)
  kind         text not null default 'expense' check (kind in ('expense', 'handover')),
  category_id  uuid,
  usual_amount numeric(14,2) check (usual_amount > 0 and usual_amount <= 200000),
  sort         integer not null default 0,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, user_id, key),
  check (key is not null or label is not null),
  -- A category that is deleted leaves the tile (it then asks for a category when edited).
  foreign key (household_id, category_id) references public.category (household_id, id)
    on delete set null (category_id)
);

create index quick_tile_user_idx on public.quick_tile (user_id);
create index quick_tile_category_idx on public.quick_tile (household_id, category_id) where category_id is not null;

create trigger quick_tile_updated_at
  before update on public.quick_tile
  for each row execute function private.set_updated_at();

create table public.quick_prefs (
  household_id    uuid not null references public.household (id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  cash_account_id uuid,
  -- learned: most used at this time of day first · mine: exactly the order I set
  order_mode      text not null default 'learned' check (order_mode in ('learned', 'mine')),
  hand            text not null default 'right' check (hand in ('right', 'left')),
  cash_check      boolean not null default true,
  cash_checked_on date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (household_id, user_id),
  foreign key (household_id, cash_account_id) references public.account (household_id, id)
    on delete set null (cash_account_id)
);

create index quick_prefs_user_idx on public.quick_prefs (user_id);
create index quick_prefs_account_idx on public.quick_prefs (household_id, cash_account_id) where cash_account_id is not null;

create trigger quick_prefs_updated_at
  before update on public.quick_prefs
  for each row execute function private.set_updated_at();

create table public.quick_entry (
  household_id   uuid not null references public.household (id) on delete cascade,
  op_id          uuid not null,
  -- Stays (with a null transaction) after the entry is deleted, so a late resend can't bring it back.
  transaction_id uuid,
  tile_id        uuid,
  kind           text not null default 'expense' check (kind in ('expense', 'handover')),
  amount         numeric(14,2) not null check (amount > 0),
  client_at      timestamptz not null,                     -- when the tile was tapped
  actor          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  primary key (household_id, op_id),
  foreign key (household_id, transaction_id) references public.money_transaction (household_id, id)
    on delete set null (transaction_id),
  foreign key (household_id, tile_id) references public.quick_tile (household_id, id)
    on delete set null (tile_id)
);

create index quick_entry_actor_idx on public.quick_entry (household_id, actor, client_at desc);
create index quick_entry_tx_idx on public.quick_entry (household_id, transaction_id) where transaction_id is not null;
create index quick_entry_tile_idx on public.quick_entry (household_id, tile_id) where tile_id is not null;
create index quick_entry_actor_fk_idx on public.quick_entry (actor);

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.quick_tile enable row level security;
alter table public.quick_prefs enable row level security;
alter table public.quick_entry enable row level security;

revoke all on table public.quick_tile from anon, authenticated;
revoke all on table public.quick_prefs from anon, authenticated;
revoke all on table public.quick_entry from anon, authenticated;

-- Tiles: read by the household, written by their owner only (never for someone else).
grant select, delete on table public.quick_tile to authenticated;
grant insert (household_id, label, icon, kind, category_id, usual_amount, sort, hidden)
  on table public.quick_tile to authenticated;
grant update (label, icon, category_id, usual_amount, sort, hidden)
  on table public.quick_tile to authenticated;

create policy quick_tile_select on public.quick_tile
  for select to authenticated
  using (private.is_member(household_id));
create policy quick_tile_insert on public.quick_tile
  for insert to authenticated
  with check (private.can_write(household_id) and user_id = (select auth.uid()));
create policy quick_tile_update on public.quick_tile
  for update to authenticated
  using (private.can_write(household_id) and user_id = (select auth.uid()))
  with check (private.can_write(household_id) and user_id = (select auth.uid()));
create policy quick_tile_delete on public.quick_tile
  for delete to authenticated
  using (private.can_write(household_id) and user_id = (select auth.uid()));

-- Settings: the row is created by rpc_quick_setup; its owner changes it.
grant select on table public.quick_prefs to authenticated;
grant update (cash_account_id, order_mode, hand, cash_check, cash_checked_on)
  on table public.quick_prefs to authenticated;

create policy quick_prefs_select on public.quick_prefs
  for select to authenticated
  using (private.is_member(household_id));
create policy quick_prefs_update on public.quick_prefs
  for update to authenticated
  using (private.can_write(household_id) and user_id = (select auth.uid()))
  with check (private.can_write(household_id) and user_id = (select auth.uid()));

-- The entry log is written by rpc_quick_spend only.
grant select on table public.quick_entry to authenticated;

create policy quick_entry_select on public.quick_entry
  for select to authenticated
  using (private.is_member(household_id));

update public.app_meta set value = '111' where key = 'schema_version';
