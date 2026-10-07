-- Phase 6b · 63 — kitchen containers and their NFC tags (MASTER_PLAN §7b, replaced 2026-10-03)
-- A jar is a place (usually of kind 'container') that holds ONE product and knows its empty weight
-- (tare, lid included). Its stock is simply the product's lots in that place, so Pantry, Places and
-- the scale all agree. An NTAG sticker under the jar is linked by its UID (one tag per container);
-- the tag also carries an NDEF URL record https://gedara.vercel.app/s/HL:LOC:… so a phone tap opens
-- the jar, and the scale can link an unknown UID by that code.

alter table public.location
  add column tare_g            numeric(14,4) check (tare_g >= 0 and tare_g <= 5000),
  add column holds_product_id  uuid,
  add column tare_set_at       timestamptz,
  add column scale_setup_until timestamptz,      -- "Weigh empty" armed: the next scale reading is the tare
  add constraint location_holds_product_fk foreign key (household_id, holds_product_id)
    references public.product (household_id, id) on delete set null (holds_product_id);

create index location_holds_product_idx on public.location (household_id, holds_product_id)
  where holds_product_id is not null;

grant insert (tare_g, holds_product_id), update (tare_g, holds_product_id) on table public.location to authenticated;

-- The product must be weighable (its stock unit converts to grams), and a container only changes
-- product while it is empty, so the jar's stock always belongs to the product it holds.
create function private.location_container_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g uuid := (select u.id from public.unit u where u.household_id is null and u.code = 'g');
begin
  if new.holds_product_id is not null
     and (tg_op = 'INSERT' or new.holds_product_id is distinct from old.holds_product_id) then
    perform private.to_stock_qty(new.holds_product_id, v_g, 1000);   -- raises GDUNT if not weighable
  end if;
  if tg_op = 'UPDATE' and old.holds_product_id is not null
     and new.holds_product_id is distinct from old.holds_product_id
     and exists (select 1 from public.stock_lot l
                  where l.household_id = old.household_id and l.location_id = old.id
                    and l.product_id = old.holds_product_id and l.qty_remaining > 0) then
    raise exception 'empty the container before it holds something else' using errcode = 'GDCNE';
  end if;
  if tg_op = 'INSERT' then
    if new.tare_g is not null then
      new.tare_set_at := now();
    end if;
  elsif new.tare_g is distinct from old.tare_g then
    new.tare_set_at := case when new.tare_g is null then null else now() end;
  end if;
  return new;
end;
$$;

create trigger location_container_check
  before insert or update of holds_product_id, tare_g on public.location
  for each row execute function private.location_container_check();

-- ── nfc_tag ───────────────────────────────────────────────────────────────────
create table public.nfc_tag (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  uid          text not null check (uid ~ '^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$'),  -- 4, 7 or 10 bytes, hex
  location_id  uuid not null,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (household_id, id),
  unique (household_id, uid),
  unique (household_id, location_id),           -- one tag per container
  foreign key (household_id, location_id) references public.location (household_id, id) on delete cascade
);

create index nfc_tag_created_by_idx on public.nfc_tag (created_by);

alter table public.nfc_tag enable row level security;
revoke all on table public.nfc_tag from anon, authenticated;
grant select on table public.nfc_tag to authenticated;

create policy nfc_tag_select on public.nfc_tag
  for select to authenticated
  using (private.is_member(household_id));

-- "04:a1:b2…" / "04 A1 B2" / "04a1b2…" → "04A1B2…", or null when it isn't a tag UID.
create function private.nfc_uid(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when u ~ '^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$' then u end
    from (select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Fa-f]', '', 'g')) as u) x
$$;

-- Link a tag to a place (replacing that place's old tag). A tag already on ANOTHER place is only
-- moved with p_move = true; otherwise GDTAG with that place's id in the detail.
create function private.nfc_link(p_household uuid, p_uid text, p_location uuid, p_move boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  text := private.nfc_uid(p_uid);
  v_old  public.nfc_tag%rowtype;
  v_id   uuid;
begin
  if v_uid is null then
    raise exception 'not a tag id' using errcode = '22023';
  end if;
  if not exists (select 1 from public.location l where l.id = p_location and l.household_id = p_household) then
    raise exception 'unknown place' using errcode = '23503';
  end if;
  select * into v_old from public.nfc_tag t where t.household_id = p_household and t.uid = v_uid for update;
  if found and v_old.location_id = p_location then
    return jsonb_build_object('id', v_old.id, 'uid', v_uid, 'location_id', p_location, 'moved_from', null);
  end if;
  if found and not coalesce(p_move, false) then
    raise exception 'this tag belongs to another place' using errcode = 'GDTAG', detail = v_old.location_id::text;
  end if;
  delete from public.nfc_tag t where t.household_id = p_household and (t.uid = v_uid or t.location_id = p_location);
  insert into public.nfc_tag (household_id, uid, location_id, last_seen_at)
  values (p_household, v_uid, p_location, now())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'uid', v_uid, 'location_id', p_location,
                            'moved_from', case when v_old.id is not null then v_old.location_id end);
end;
$$;

revoke execute on function private.nfc_uid(text) from public, anon, authenticated;
revoke execute on function private.nfc_link(uuid, text, uuid, boolean) from public, anon, authenticated;

create function public.rpc_nfc_tag_link(p_location uuid, p_uid text, p_move boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select l.household_id into v_household from public.location l where l.id = p_location;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.nfc_link(v_household, p_uid, p_location, p_move);
end;
$$;

create function public.rpc_nfc_tag_unlink(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select t.household_id into v_household from public.nfc_tag t where t.id = p_id;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.nfc_tag t where t.id = p_id;
end;
$$;

revoke execute on function public.rpc_nfc_tag_link(uuid, text, boolean) from public, anon;
revoke execute on function public.rpc_nfc_tag_unlink(uuid) from public, anon;
grant execute on function public.rpc_nfc_tag_link(uuid, text, boolean) to authenticated;
grant execute on function public.rpc_nfc_tag_unlink(uuid) to authenticated;

update public.app_meta set value = '63' where key = 'schema_version';
