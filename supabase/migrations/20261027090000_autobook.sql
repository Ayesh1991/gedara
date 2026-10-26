-- Phase 9c · 95 — Gedara books certain kinds by itself, and shows "What changed".
--
-- The matching run (match-agent) already finds the certain answers: an alert that is a bill already
-- entered, a debit + the card payment it paid, a note, a category a payee's receipt decides or a shop
-- you taught, a bill line whose printed name you taught as a product. 9c lets it book those — never an
-- AI answer — but only:
--   * for the kinds the owner switched on (match_setting.auto), and
--   * while that kind's record on the household's own past bookings is ≥ 99 % right on ≥ 20 cases
--     (match_setting.auto_record, recomputed by every run: the rules replayed on decided alerts).
-- It books with the same RPCs a person uses (rpc_sms_link / rpc_sms_post / rpc_sms_ignore /
-- rpc_line_link_product), acting as the household owner for that transaction only, and logs each
-- booking in match_autobook so "What changed" can show it with one-tap Undo. An undone alert or line
-- is never booked by itself again.
--
-- The existing matching functions are extended, not copied: each moves to `private` under a versioned
-- name and the public name becomes a thin wrapper (bundle + save + settings + request; attention and
-- housekeeping likewise).
--   * rpc_match_request takes a per-household lock: two "Check now" in the same second can't both start.

-- ── Settings: the switches and the record ────────────────────────────────────
alter table public.match_setting
  add column auto           jsonb not null default '[]' check (jsonb_typeof(auto) = 'array'),
  add column auto_record    jsonb not null default '{}' check (jsonb_typeof(auto_record) = 'object'),
  add column auto_record_at timestamptz;

-- The kinds and the bar (keep in step with supabase/functions/_shared/match/book.ts)
create function private.autobook_kinds()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['alert_link', 'alert_transfer', 'alert_note', 'category_evidence', 'category_rule', 'line_product']
$$;

create function private.autobook_qualifies(p_record jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p_record) = 'object'
                  and (p_record ->> 'of')::integer >= 20
                  and (p_record ->> 'right')::numeric >= 0.99 * (p_record ->> 'of')::numeric, false)
$$;

-- ── The log of what Gedara booked ─────────────────────────────────────────────
create table public.match_autobook (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  run_id         uuid,
  kind           text not null check (kind = any (private.autobook_kinds())),
  action         text not null check (action in ('link', 'post', 'seen', 'line')),
  sms_ids        uuid[] not null default '{}',
  line_id        uuid,
  transaction_id uuid,            -- the entry made (post) or linked to (link); may be deleted since
  summary        jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  before         jsonb not null default '{}' check (jsonb_typeof(before) = 'object'),
  created_at     timestamptz not null default now(),
  undone_at      timestamptz,
  undone_by      uuid,
  reviewed_at    timestamptz,
  reviewed_by    uuid,
  foreign key (household_id, run_id) references public.match_run (household_id, id) on delete set null (run_id)
);
create index match_autobook_recent_idx on public.match_autobook (household_id, created_at desc);
create index match_autobook_open_idx on public.match_autobook (household_id)
  where undone_at is null and reviewed_at is null;

alter table public.match_autobook enable row level security;
revoke all on table public.match_autobook from anon, authenticated;
grant select on table public.match_autobook to authenticated;
create policy match_autobook_select on public.match_autobook for select to authenticated using (private.is_member(household_id));

-- ── Book (service role only, inside a run) ────────────────────────────────────
-- p_items: [{ kind, action, sms_ids, tx_id?, payload?, line_id?, product_id?, summary }] (≤ 50).
-- Returns { booked, skipped, failed, sms_ids, line_ids } (what was booked). One failing item never stops
-- the others.
create function public.rpc_match_autobook(p_household uuid, p_run uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set      public.match_setting;
  v_owner    uuid;
  v_claims   text := current_setting('request.jwt.claims', true);
  v_sub      text := current_setting('request.jwt.claim.sub', true);
  v_item     jsonb;
  v_kind     text;
  v_action   text;
  v_want     text;
  v_ids      uuid[];
  v_line     uuid;
  v_tx       uuid;
  v_before   jsonb;
  v_res      jsonb;
  v_booked   integer := 0;
  v_skipped  integer := 0;
  v_failed   integer := 0;
  v_done_sms uuid[] := '{}';
  v_done_ln  uuid[] := '{}';
begin
  if not exists (select 1 from public.match_run r where r.id = p_run and r.household_id = p_household and r.finished_at is null) then
    raise exception 'no such run' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'too much at once' using errcode = '23514';
  end if;
  select * into v_set from public.match_setting s where s.household_id = p_household;
  select m.user_id into v_owner from public.household_member m
   where m.household_id = p_household and m.role = 'owner' order by m.created_at limit 1;
  if v_set.household_id is null or v_owner is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('booked', 0, 'skipped', jsonb_array_length(p_items), 'failed', 0, 'sms_ids', '[]'::jsonb, 'line_ids', '[]'::jsonb);
  end if;

  -- act as the owner for the rest of this call (the person RPCs check can_write(auth.uid()))
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_kind := v_item ->> 'kind';
    v_action := v_item ->> 'action';
    v_ids := coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'sms_ids', '[]'))::uuid), '{}');
    v_line := (v_item ->> 'line_id')::uuid;
    v_want := case v_kind when 'alert_link' then 'link' when 'alert_note' then 'seen'
                          when 'line_product' then 'line' else 'post' end;
    -- switched on, still qualified, the action this kind books, nothing a person undid before
    if not (v_set.auto ? v_kind) or not private.autobook_qualifies(v_set.auto_record -> v_kind)
       or v_action is distinct from v_want
       or (v_action = 'line') <> (v_line is not null) or (v_action <> 'line' and cardinality(v_ids) = 0)
       or exists (select 1 from public.match_autobook b where b.household_id = p_household and b.undone_at is not null
                    and (b.sms_ids && v_ids or b.line_id = v_line))
       or exists (select 1 from unnest(v_ids) i where not exists (
                    select 1 from public.sms_message s where s.id = i and s.household_id = p_household)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      v_tx := null;
      v_before := '{}';
      if v_action = 'link' then
        v_tx := (v_item ->> 'tx_id')::uuid;
        select jsonb_build_object('account_id', t.account_id) into v_before from public.money_transaction t
         where t.id = v_tx and t.household_id = p_household;
        v_res := public.rpc_sms_link(v_ids, v_tx);
        if (v_res ->> 'moved')::boolean then
          v_before := v_before || '{"moved": true}';
        end if;
      elsif v_action = 'post' then
        v_res := public.rpc_sms_post(v_ids, v_item -> 'payload');
        v_tx := (v_res ->> 'id')::uuid;
      elsif v_action = 'seen' then
        if public.rpc_sms_ignore(v_ids, true) <> cardinality(v_ids) then
          raise exception 'already reviewed' using errcode = 'GDLNK';
        end if;
      else
        select jsonb_build_object('product_id', l.product_id, 'destiny', l.destiny) into v_before
          from public.transaction_line l where l.id = v_line and l.household_id = p_household and l.product_id is null;
        if v_before is null then
          raise exception 'not allowed' using errcode = '42501';
        end if;
        perform public.rpc_line_link_product(v_line, (v_item ->> 'product_id')::uuid, 'stock');
      end if;

      insert into public.match_autobook (household_id, run_id, kind, action, sms_ids, line_id, transaction_id, summary, before)
      values (p_household, p_run, v_kind, v_action, v_ids, v_line, v_tx,
              coalesce(v_item -> 'summary', '{}'), coalesce(v_before, '{}'));
      -- a suggestion still open for it is settled by the booking
      update public.match_suggestion m set status = 'stale', updated_at = now()
       where m.household_id = p_household and m.status = 'pending'
         and (m.sms_id = any (v_ids) or m.line_id = v_line);
      v_booked := v_booked + 1;
      v_done_sms := v_done_sms || v_ids;
      if v_line is not null then
        v_done_ln := v_done_ln || v_line;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return jsonb_build_object('booked', v_booked, 'skipped', v_skipped, 'failed', v_failed,
                            'sms_ids', to_jsonb(v_done_sms), 'line_ids', to_jsonb(v_done_ln));
end;
$$;

-- ── Undo (members) ────────────────────────────────────────────────────────────
-- The entry Gedara made is deleted, a link is taken back (a bill it moved off "to be matched" goes
-- back there), a note is un-seen, a line loses its product. The alert / line waits again and is never
-- booked by itself again.
create function public.rpc_match_autobook_undo(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.match_autobook;
begin
  select * into v_b from public.match_autobook b where b.id = p_id for update;
  if not found or not private.can_write(v_b.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_b.undone_at is not null then
    return;
  end if;

  if v_b.action = 'post' then
    if exists (select 1 from public.money_transaction t where t.id = v_b.transaction_id and t.household_id = v_b.household_id) then
      perform public.rpc_delete_transaction(v_b.transaction_id, false);
    end if;
  elsif v_b.action = 'link' then
    update public.sms_message s set transaction_id = null, reviewed_by = null, reviewed_at = null
     where s.household_id = v_b.household_id and s.id = any (v_b.sms_ids) and s.transaction_id = v_b.transaction_id;
    if (v_b.before ->> 'moved')::boolean then
      update public.money_transaction t set account_id = (v_b.before ->> 'account_id')::uuid
       where t.id = v_b.transaction_id and t.household_id = v_b.household_id
         and not exists (select 1 from public.sms_message s where s.household_id = t.household_id and s.transaction_id = t.id);
    end if;
  elsif v_b.action = 'seen' then
    update public.sms_message s set ignored = false, reviewed_by = null, reviewed_at = null
     where s.household_id = v_b.household_id and s.id = any (v_b.sms_ids) and s.ignored;
  else
    if exists (select 1 from public.stock_lot k where k.household_id = v_b.household_id and k.transaction_line_id = v_b.line_id) then
      raise exception 'this line already feeds the pantry' using errcode = 'GDRTD';
    end if;
    update public.transaction_line l
       set product_id = (v_b.before ->> 'product_id')::uuid, destiny = coalesce(v_b.before ->> 'destiny', l.destiny)
     where l.id = v_b.line_id and l.household_id = v_b.household_id;
  end if;

  update public.match_autobook b set undone_at = now(), undone_by = auth.uid(),
         reviewed_at = coalesce(b.reviewed_at, now()), reviewed_by = coalesce(b.reviewed_by, auth.uid())
   where b.id = v_b.id;
end;
$$;

-- "Looks right": returns how many were marked.
create function public.rpc_match_autobook_seen(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
begin
  select min(b.household_id::text)::uuid into v_household from public.match_autobook b
   where b.id = any (p_ids)
  having count(distinct b.household_id) = 1 and count(*) = cardinality(p_ids);
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.match_autobook b set reviewed_at = now(), reviewed_by = auth.uid()
   where b.id = any (p_ids) and b.reviewed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── Settings: + auto (owner; a kind is switched on only while it qualifies) ──
alter function public.rpc_match_settings_save(uuid, jsonb) set schema private;
alter function private.rpc_match_settings_save(uuid, jsonb) rename to match_settings_save_v84;
revoke execute on function private.match_settings_save_v84(uuid, jsonb) from public, anon, authenticated, service_role;

create function public.rpc_match_settings_save(p_household uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old    jsonb;
  v_record jsonb;
  v_kind   text;
begin
  perform private.match_settings_save_v84(p_household, p - 'auto');
  if p ? 'auto' then
    if jsonb_typeof(p -> 'auto') <> 'array' then
      raise exception 'auto: a list of kinds' using errcode = '23514';
    end if;
    select s.auto, s.auto_record into v_old, v_record from public.match_setting s where s.household_id = p_household;
    for v_kind in select distinct value from jsonb_array_elements_text(p -> 'auto') loop
      if not (v_kind = any (private.autobook_kinds())) then
        raise exception 'unknown kind' using errcode = '23514';
      end if;
      if not (v_old ? v_kind) and not private.autobook_qualifies(v_record -> v_kind) then
        raise exception 'not proven yet' using errcode = '23514';
      end if;
    end loop;
    update public.match_setting s
       set auto = (select coalesce(jsonb_agg(distinct x.value), '[]') from jsonb_array_elements_text(p -> 'auto') x),
           updated_by = auth.uid(), updated_at = now()
     where s.household_id = p_household;
  end if;
end;
$$;

-- ── Save a run: + the record per kind ─────────────────────────────────────────
alter function public.rpc_match_save(uuid, uuid, jsonb) set schema private;
alter function private.rpc_match_save(uuid, uuid, jsonb) rename to match_save_v80;
revoke execute on function private.match_save_v80(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

create function public.rpc_match_save(p_household uuid, p_run uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record jsonb;
begin
  if jsonb_typeof(p -> 'record') = 'object'
     and exists (select 1 from public.match_run r where r.id = p_run and r.household_id = p_household and r.finished_at is null) then
    -- known kinds only, whole numbers, right ≤ of
    select coalesce(jsonb_object_agg(e.key, jsonb_build_object('right', (e.value ->> 'right')::integer, 'of', (e.value ->> 'of')::integer)), '{}')
      into v_record
      from jsonb_each(p -> 'record') e
     where e.key = any (private.autobook_kinds()) and jsonb_typeof(e.value) = 'object'
       and (e.value ->> 'of') ~ '^\d{1,6}$' and (e.value ->> 'right') ~ '^\d{1,6}$'
       and (e.value ->> 'right')::integer <= (e.value ->> 'of')::integer;
    insert into public.match_setting as s (household_id, auto_record, auto_record_at)
    values (p_household, v_record, now())
    on conflict (household_id) do update set auto_record = excluded.auto_record, auto_record_at = now();
  end if;
  return private.match_save_v80(p_household, p_run, p - 'record');
end;
$$;

-- ── The bundle: + household id, what was undone, the learned-name line record ─
alter function public.rpc_match_bundle(uuid, uuid, text) set schema private;
alter function private.rpc_match_bundle(uuid, uuid, text) rename to match_bundle_v88;
revoke execute on function private.match_bundle_v88(uuid, uuid, text) from public, anon, authenticated, service_role;

create function public.rpc_match_bundle(p_household uuid, p_run uuid, p_mode text default 'run')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return private.match_bundle_v88(p_household, p_run, p_mode) || jsonb_build_object(
    'household_id', p_household,
    'autobook_undone', jsonb_build_object(
      'sms', (select coalesce(jsonb_agg(distinct i), '[]') from public.match_autobook b, unnest(b.sms_ids) i
               where b.household_id = p_household and b.undone_at is not null),
      'lines', (select coalesce(jsonb_agg(distinct b.line_id), '[]') from public.match_autobook b
                 where b.household_id = p_household and b.undone_at is not null and b.line_id is not null)),
    -- learned-name product suggestions: Yes vs Change / Skip
    'line_rule_record', (select jsonb_build_object('right', count(*) filter (where s.status = 'accepted'), 'of', count(*))
                           from public.match_suggestion s
                          where s.household_id = p_household and s.task = 'line_product' and s.pattern = 'rule'
                            and s.status in ('accepted', 'changed', 'rejected')));
end;
$$;

-- ── Ask for a run: one at a time per household ────────────────────────────────
alter function public.rpc_match_request(uuid, text) set schema private;
alter function private.rpc_match_request(uuid, text) rename to match_request_v82;
revoke execute on function private.match_request_v82(uuid, text) from public, anon, authenticated, service_role;

create function public.rpc_match_request(p_household uuid, p_trigger text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- held until this call commits: a second request waits, then sees the first run ("too often")
  perform pg_advisory_xact_lock(hashtextextended('gedara.match_request:' || p_household::text, 0));
  return private.match_request_v82(p_household, p_trigger);
end;
$$;

-- ── Attention: "Gedara booked N things (not looked at yet)" ───────────────────
alter function private.attention_items(uuid) rename to attention_items_v81;
revoke execute on function private.attention_items_v81(uuid) from public, anon, authenticated;

create function private.attention_items(p_household uuid)
returns table (item_key text, kind text, severity text, entity_type text, entity_id uuid, title text,
               due_on date, days_left integer, amount numeric, qty numeric, unit text, extra jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.attention_items_v81(p_household)
  union all
  select 'autobook:' || count(*) || ':' || extract(epoch from max(b.created_at))::bigint, 'autobook_review', 'violet', 'queue',
         null, null, null, null, null, count(*), null, '{}'::jsonb
    from public.match_autobook b
   where b.household_id = p_household and b.undone_at is null and b.reviewed_at is null
  having count(*) > 0
$$;

revoke execute on function private.attention_items(uuid) from public, anon, authenticated;

-- ── Housekeeping: half a year of "What changed" ───────────────────────────────
alter function private.housekeeping() rename to housekeeping_v81;
revoke execute on function private.housekeeping_v81() from public, anon, authenticated;

create function private.housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.housekeeping_v81();
  delete from public.match_autobook b where b.created_at < now() - interval '180 days'
     and (b.reviewed_at is not null or b.undone_at is not null);
end;
$$;

revoke execute on function private.housekeeping() from public, anon, authenticated;

-- ── Privileges ────────────────────────────────────────────────────────────────
revoke execute on function public.rpc_match_autobook(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_match_autobook(uuid, uuid, jsonb) to service_role;
revoke execute on function public.rpc_match_bundle(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rpc_match_bundle(uuid, uuid, text) to service_role;
revoke execute on function public.rpc_match_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_match_save(uuid, uuid, jsonb) to service_role;

revoke execute on function public.rpc_match_autobook_undo(uuid) from public, anon;
revoke execute on function public.rpc_match_autobook_seen(uuid[]) from public, anon;
revoke execute on function public.rpc_match_settings_save(uuid, jsonb) from public, anon;
revoke execute on function public.rpc_match_request(uuid, text) from public, anon;
grant execute on function public.rpc_match_autobook_undo(uuid) to authenticated;
grant execute on function public.rpc_match_autobook_seen(uuid[]) to authenticated;
grant execute on function public.rpc_match_settings_save(uuid, jsonb) to authenticated;
grant execute on function public.rpc_match_request(uuid, text) to authenticated;

revoke execute on function private.autobook_kinds() from public, anon, authenticated;
revoke execute on function private.autobook_qualifies(jsonb) from public, anon, authenticated;

update public.app_meta set value = '95' where key = 'schema_version';
