-- Phase 5 · 36 — activity timeline (MASTER_PLAN §3.7)
-- One append-only table of "what happened", written by triggers only. Phase 5 records the life of
-- an asset (created → moved → lent → returned → sold …); Phase 6 adds other entities and the
-- Attention feed. The asset page merges it with the purchase and the maintenance logs.

create table public.activity (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.household (id) on delete cascade,
  at           timestamptz not null default now(),
  actor        uuid default auth.uid() references auth.users (id) on delete set null,
  entity_type  text not null check (entity_type ~ '^[a-z_]{1,30}$'),
  entity_id    uuid not null,
  verb         text not null check (verb ~ '^[a-z_]{1,30}$'),
  summary      text check (length(summary) <= 200),
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')
);

create index activity_entity_idx on public.activity (household_id, entity_type, entity_id, at desc);
create index activity_at_idx on public.activity (household_id, at desc);
create index activity_actor_idx on public.activity (actor);

-- ── Asset events ──────────────────────────────────────────────────────────────
-- created · moved {from, to, from_path, to_path} · lent {to} · returned {from} · sold {price, to}
-- · unsold · status {from, to} (stored / in repair / disposed / lost / back in use)
create function private.asset_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_to   text;
begin
  if tg_op = 'INSERT' then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id, 'created', new.name,
            jsonb_build_object('location_id', new.location_id, 'from_bill', new.transaction_line_id is not null));
    return null;
  end if;

  if new.location_id is distinct from old.location_id then
    select l.path into v_from from public.location l where l.id = old.location_id;
    select l.path into v_to from public.location l where l.id = new.location_id;
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id, 'moved', left(coalesce(v_to, '—'), 200),
            jsonb_build_object('from', old.location_id, 'to', new.location_id, 'from_path', v_from, 'to_path', v_to));
  end if;

  if new.status is distinct from old.status then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, 'asset', new.id,
            case
              when new.status = 'sold' then 'sold'
              when old.status = 'sold' then 'unsold'
              when new.status = 'lent' then 'lent'
              when old.status = 'lent' then 'returned'
              else 'status'
            end,
            case
              when new.status = 'sold' then new.sold_to
              when new.status = 'lent' then new.lent_to
              when old.status = 'lent' then old.lent_to
            end,
            jsonb_build_object('from', old.status, 'to', new.status)
              || case when new.status = 'lent' then jsonb_build_object('lent_to', new.lent_to) else '{}'::jsonb end
              || case when old.status = 'lent' then jsonb_build_object('lent_to', old.lent_to, 'lent_on', old.lent_on) else '{}'::jsonb end
              || case when new.status = 'sold' then jsonb_build_object('price', new.sold_price, 'sold_to', new.sold_to) else '{}'::jsonb end);
  end if;
  return null;
end;
$$;

create trigger asset_activity
  after insert or update of location_id, status on public.asset
  for each row execute function private.asset_activity();

-- An asset's history goes with it.
create function private.asset_delete_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.activity a
   where a.entity_type = 'asset' and a.entity_id = old.id and a.household_id = old.household_id;
  return null;
end;
$$;

create trigger asset_delete_activity
  after delete on public.asset
  for each row execute function private.asset_delete_activity();

-- ── RLS + privileges: read-only to clients ────────────────────────────────────
alter table public.activity enable row level security;

revoke all on table public.activity from anon, authenticated;
grant select on table public.activity to authenticated;

create policy activity_select on public.activity for select to authenticated
  using (private.is_member(household_id));

update public.app_meta set value = '36' where key = 'schema_version';
