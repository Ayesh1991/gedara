-- Phase 9 · 79 — what the household taught the matcher, shared by every device.
--
-- Until now "this shop is Groceries, paid by the Seylan card" lived in each browser's localStorage
-- (lib/sms/queries.ts, lib/money/queries.ts) and bill-line category corrections were not kept at all.
--   * merchant_memory: a shop / alert merchant text → category and usual account;
--   * line_memory: a printed bill name → category.
-- Keys are private.bill_name_norm (mirrored by lib/spine/normalise.ts). Written only by
-- rpc_memory_learn (hits counted, last choice wins); members read and can forget a row.

create table public.merchant_memory (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  merchant_norm text not null check (length(merchant_norm) between 1 and 200
                                     and merchant_norm = private.bill_name_norm(merchant_norm)),
  category_id  uuid,
  account_id   uuid,
  hits         integer not null default 1 check (hits > 0),
  last_used_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (household_id, merchant_norm),
  check (category_id is not null or account_id is not null),
  foreign key (household_id, category_id) references public.category (household_id, id) on delete cascade,
  foreign key (household_id, account_id) references public.account (household_id, id) on delete set null (account_id)
);

create table public.line_memory (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  name_norm    text not null check (length(name_norm) between 1 and 200 and name_norm = private.bill_name_norm(name_norm)),
  category_id  uuid not null,
  hits         integer not null default 1 check (hits > 0),
  last_used_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (household_id, name_norm),
  foreign key (household_id, category_id) references public.category (household_id, id) on delete cascade
);

-- ── RLS + privileges: read and forget; learning only through the RPC ─────────
alter table public.merchant_memory enable row level security;
alter table public.line_memory enable row level security;

revoke all on table public.merchant_memory, public.line_memory from anon, authenticated;
grant select, delete on table public.merchant_memory, public.line_memory to authenticated;

create policy merchant_memory_select on public.merchant_memory
  for select to authenticated using (private.is_member(household_id));
create policy merchant_memory_delete on public.merchant_memory
  for delete to authenticated using (private.can_write(household_id));
create policy line_memory_select on public.line_memory
  for select to authenticated using (private.is_member(household_id));
create policy line_memory_delete on public.line_memory
  for delete to authenticated using (private.can_write(household_id));

-- p_items: [{ kind: 'merchant' | 'line', text, category_id?, account_id? }] (at most 300).
-- A merchant item without a category keeps the one remembered (and the same for the account).
-- Returns how many rows were learned.
create function public.rpc_memory_learn(p_household uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i     jsonb;
  v_key   text;
  v_cat   uuid;
  v_acc   uuid;
  v_count integer := 0;
begin
  if not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 300 then
    raise exception 'items must be an array of at most 300' using errcode = '23514';
  end if;

  for v_i in select value from jsonb_array_elements(p_items) loop
    v_key := left(private.bill_name_norm(v_i ->> 'text'), 200);
    v_cat := (v_i ->> 'category_id')::uuid;
    v_acc := (v_i ->> 'account_id')::uuid;
    if v_key = '' then
      continue;
    end if;
    -- another household's category / account is refused by the composite foreign keys

    if v_i ->> 'kind' = 'merchant' then
      if v_cat is null and v_acc is null then
        continue;
      end if;
      insert into public.merchant_memory as m (household_id, merchant_norm, category_id, account_id)
      values (p_household, v_key, v_cat, v_acc)
      on conflict (household_id, merchant_norm) do update
        set category_id = coalesce(excluded.category_id, m.category_id),
            account_id = coalesce(excluded.account_id, m.account_id),
            hits = m.hits + 1, last_used_at = now();
    elsif v_i ->> 'kind' = 'line' then
      if v_cat is null then
        continue;
      end if;
      insert into public.line_memory as l (household_id, name_norm, category_id)
      values (p_household, v_key, v_cat)
      on conflict (household_id, name_norm) do update
        set category_id = excluded.category_id, hits = l.hits + 1, last_used_at = now();
    else
      raise exception 'unknown memory kind' using errcode = '22023';
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.rpc_memory_learn(uuid, jsonb) from public, anon;
grant execute on function public.rpc_memory_learn(uuid, jsonb) to authenticated;

update public.app_meta set value = '79' where key = 'schema_version';
