-- Phase 4 · 28 — learned bill names (MASTER_PLAN §4 row 1: "matched barcode → alias → name")
-- The first time "ANCHOR HOT CHOC 400G" is sent to the product "Hot chocolate", that printed name is
-- remembered; the next bill with the same name is matched without asking. A name can also be
-- remembered as "not stock" (e.g. bottled water in a grocery category) so it isn't asked again.
-- Matching itself runs in the web app (lib/spine/match.ts); the database stores what was learned.
-- Rows are written only by the bill-routing RPCs (migration 31); members can read and forget them.

-- Printed bill name → lookup key: lower-case, ASCII punctuation to spaces, single spaces.
-- Mirrored exactly by lib/spine/normalise.ts (non-ASCII letters, e.g. Sinhala, are kept as they are).
create function private.bill_name_norm(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
           regexp_replace(lower(coalesce(p, '')), '[!-/:-@\[-`{-~]', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

grant execute on function private.bill_name_norm(text) to authenticated;

create table public.product_alias (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  alias_norm   text not null check (length(alias_norm) between 1 and 200 and alias_norm = private.bill_name_norm(alias_norm)),
  destiny      text not null check (destiny in ('stock', 'asset', 'expense')),
  product_id   uuid,                                    -- set exactly when destiny = 'stock'
  merchant_id  uuid,                                    -- where it was last seen
  hits         integer not null default 1 check (hits > 0),
  last_used_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (household_id, alias_norm),
  check ((destiny = 'stock') = (product_id is not null)),
  foreign key (household_id, product_id) references public.product (household_id, id) on delete cascade,
  foreign key (household_id, merchant_id) references public.merchant (household_id, id)
    on delete set null (merchant_id)
);

create index product_alias_product_idx on public.product_alias (household_id, product_id) where product_id is not null;
create index product_alias_merchant_idx on public.product_alias (household_id, merchant_id) where merchant_id is not null;

-- ── RLS + privileges: read and forget; learning happens only in the RPCs ──────
alter table public.product_alias enable row level security;

revoke all on table public.product_alias from anon, authenticated;
grant select, delete on table public.product_alias to authenticated;

create policy product_alias_select on public.product_alias
  for select to authenticated
  using (private.is_member(household_id));

create policy product_alias_delete on public.product_alias
  for delete to authenticated
  using (private.can_write(household_id));

update public.app_meta set value = '28' where key = 'schema_version';
