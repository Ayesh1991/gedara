-- Phase 7b · 57 — blank label RPCs + per-sheet counts
--   rpc_label_sheets   make N new sheets of never-used HL:TAG codes
--   rpc_label_printed  count a (re)print of a sheet
--   rpc_tag_assign     "New label — what is this?": point a blank label at a place / thing / product
--   rpc_tag_detach     Undo / "Detach this label": the same sticker becomes blank again
--   rpc_tag_retire     the label was thrown away or lost: it never opens anything again
-- A code of another household is reported as unknown (its existence is not revealed).
--
-- Error codes the app maps to messages:
--   GDTAG  detail 'assigned' (already means something) · 'retired' · 'changed' (not what you expected)

-- The caller's tag, locked. Unknown or someone else's → 23503 "unknown label".
create function private.tag_for_write(p_code text)
returns public.label_tag
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.label_tag%rowtype;
begin
  select * into v from public.label_tag t where t.code = upper(btrim(p_code)) for update;
  if not found or not private.is_member(v.household_id) then
    raise exception 'unknown label' using errcode = '23503';
  end if;
  if not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return v;
end;
$$;

create function public.rpc_label_sheets(p_household uuid, p_format text, p_count integer, p_slots integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_no    integer;
  v_sheet uuid;
  v_out   jsonb := '[]'::jsonb;
begin
  if p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('a4', 'a4mini', 'sq20', 'sq10') then
    raise exception 'unknown label format' using errcode = '23514';
  end if;
  if p_count is null or p_count not between 1 and 10 then
    raise exception 'between 1 and 10 sheets at a time' using errcode = '23514';
  end if;
  if p_slots is null or p_slots not between 1 and 300 then
    raise exception 'between 1 and 300 labels per sheet' using errcode = '23514';
  end if;

  for i in 1 .. p_count loop
    insert into private.label_sheet_counter as c (household_id, last_no)
    values (p_household, 1)
    on conflict (household_id) do update set last_no = c.last_no + 1
    returning c.last_no into v_no;

    insert into public.label_sheet (household_id, sheet_no, format, slots)
    values (p_household, v_no, p_format, p_slots)
    returning id into v_sheet;

    for s in 0 .. p_slots - 1 loop
      insert into public.label_tag (household_id, sheet_id, slot, code)
      values (p_household, v_sheet, s, private.new_hl_code('TAG', 'public.label_tag'::regclass));
    end loop;

    v_out := v_out || jsonb_build_object('id', v_sheet, 'sheet_no', v_no);
  end loop;
  return v_out;
end;
$$;

create function public.rpc_label_printed(p_sheet uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select s.household_id into v_household from public.label_sheet s where s.id = p_sheet;
  if not found or not private.is_member(v_household) then
    raise exception 'unknown sheet' using errcode = '23503';
  end if;
  if not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.label_sheet s
     set print_count = s.print_count + 1, last_printed_at = now()
   where s.id = p_sheet;
end;
$$;

-- p_kind: 'location' | 'asset' | 'product'
create function public.rpc_tag_assign(p_code text, p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.label_tag%rowtype := private.tag_for_write(p_code);
  v_ok   boolean;
begin
  if v.retired_at is not null then
    raise exception 'this label was retired' using errcode = 'GDTAG', detail = 'retired';
  end if;
  if num_nonnulls(v.location_id, v.asset_id, v.product_id) > 0 then
    raise exception 'this label already means something' using errcode = 'GDTAG', detail = 'assigned';
  end if;

  v_ok := case p_kind
            when 'location' then exists (select 1 from public.location l where l.id = p_id and l.household_id = v.household_id)
            when 'asset' then exists (select 1 from public.asset a where a.id = p_id and a.household_id = v.household_id)
            when 'product' then exists (select 1 from public.product p where p.id = p_id and p.household_id = v.household_id)
          end;
  if v_ok is null then
    raise exception 'unknown kind' using errcode = '23514';
  end if;
  if not v_ok then
    raise exception 'unknown item' using errcode = '23503';
  end if;

  update public.label_tag t
     set location_id = case when p_kind = 'location' then p_id end,
         asset_id    = case when p_kind = 'asset' then p_id end,
         product_id  = case when p_kind = 'product' then p_id end,
         assigned_at = now(),
         assigned_by = auth.uid()
   where t.id = v.id;

  return jsonb_build_object('code', v.code, 'kind', p_kind, 'id', p_id);
end;
$$;

-- Empties the label only if it still means p_expect_id (so an old Undo can't detach a newer choice).
create function public.rpc_tag_detach(p_code text, p_expect_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.label_tag%rowtype := private.tag_for_write(p_code);
begin
  if coalesce(v.location_id, v.asset_id, v.product_id) is distinct from p_expect_id or p_expect_id is null then
    raise exception 'this label means something else now' using errcode = 'GDTAG', detail = 'changed';
  end if;
  update public.label_tag t
     set location_id = null, asset_id = null, product_id = null, assigned_at = null, assigned_by = null
   where t.id = v.id;
end;
$$;

create function public.rpc_tag_retire(p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.label_tag%rowtype := private.tag_for_write(p_code);
begin
  if v.retired_at is not null then
    return;
  end if;
  update public.label_tag t
     set location_id = null, asset_id = null, product_id = null, retired_at = now()
   where t.id = v.id;
end;
$$;

-- Sheets with how many labels are still blank / in use / retired ("a small page shows my sheets").
create view public.v_label_sheet
with (security_invoker = true) as
select s.id, s.household_id, s.sheet_no, s.format, s.slots, s.print_count, s.last_printed_at, s.created_at,
       count(*) filter (where t.retired_at is null
                          and num_nonnulls(t.location_id, t.asset_id, t.product_id) = 0)::integer as unused,
       count(*) filter (where num_nonnulls(t.location_id, t.asset_id, t.product_id) > 0)::integer as used,
       count(*) filter (where t.retired_at is not null)::integer as retired
  from public.label_sheet s
  left join public.label_tag t on t.sheet_id = s.id
 group by s.id;

revoke all on table public.v_label_sheet from anon, authenticated;
grant select on table public.v_label_sheet to authenticated;

revoke execute on function private.tag_for_write(text) from public, anon, authenticated;
revoke execute on function public.rpc_label_sheets(uuid, text, integer, integer) from public, anon;
revoke execute on function public.rpc_label_printed(uuid) from public, anon;
revoke execute on function public.rpc_tag_assign(text, text, uuid) from public, anon;
revoke execute on function public.rpc_tag_detach(text, uuid) from public, anon;
revoke execute on function public.rpc_tag_retire(text) from public, anon;
grant execute on function public.rpc_label_sheets(uuid, text, integer, integer) to authenticated;
grant execute on function public.rpc_label_printed(uuid) to authenticated;
grant execute on function public.rpc_tag_assign(text, text, uuid) to authenticated;
grant execute on function public.rpc_tag_detach(text, uuid) to authenticated;
grant execute on function public.rpc_tag_retire(text) to authenticated;

update public.app_meta set value = '57' where key = 'schema_version';
