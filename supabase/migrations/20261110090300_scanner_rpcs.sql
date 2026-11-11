-- Phase 11 · 108 — the scanner's one round trip, and what people do with its scans
-- rpc_scanner_sync is called only by the scanner-ingest Edge Function (service role) with the
-- sha256 of the scanner's key. The household comes from the key, never from the request. The
-- scanner can do exactly this: use / add / open / waste / check a scanned code, and undo ITS OWN
-- last scan. Each event is stored once per (device, epoch, seq); a resend returns the first answer.
--
-- Limits (a wrong or stolen key must not be able to empty the pantry):
--   · 120 events per 10 minutes per scanner (GDRTE → 429);
--   · 20 stock-changing scans within one minute of scan time, 150 packs a day, 50 added packs a day:
--     past any of them the scanner is PAUSED: scans are kept as 'held' and change nothing until the
--     owner resumes it (the function alerts the owner at once). Everything it did can be taken
--     back with rpc_scanner_undo_since.

create function private.bin_display_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- The scanner's screen has Latin letters only.
  select case when p_name ~ '^[ -~]+$' then left(btrim(p_name), 24) else 'Item' end
$$;

-- Store one event from its result object. Returns the row id.
create function private.bin_store(p_household uuid, p_device uuid, p_epoch bigint, p_seq bigint, p_at timestamptz,
                                  p_estimated boolean, p_kind text, p_mode text, p_count integer, p_code text,
                                  p_res jsonb, p_error text)
returns uuid
language sql
set search_path = ''
as $$
  insert into public.bin_scan
    (household_id, device_id, epoch, seq, at, time_estimated, kind, mode, count, code, code_kind, product_id, lot_id,
     status, qty, left_qty, correlation_id, list_item_id, target_id, error_code, result)
  values
    (p_household, p_device, p_epoch, p_seq, p_at, p_estimated, p_kind, p_mode, coalesce(p_count, 1), p_code,
     p_res ->> 'code_kind', (p_res ->> 'product_id')::uuid, (p_res ->> 'lot_id')::uuid,
     p_res ->> 'status', (p_res ->> 'qty')::numeric, (p_res ->> 'left_qty')::numeric,
     (p_res ->> 'correlation_id')::uuid, (p_res ->> 'list_item_id')::uuid, (p_res ->> 'target_id')::uuid,
     p_error, p_res)
  returning id
$$;

-- Write a (re)applied result onto a waiting row.
create function private.bin_restore(p_id uuid, p_res jsonb, p_by uuid)
returns void
language sql
set search_path = ''
as $$
  update public.bin_scan s set
    code_kind = coalesce(p_res ->> 'code_kind', s.code_kind),
    product_id = (p_res ->> 'product_id')::uuid,
    lot_id = (p_res ->> 'lot_id')::uuid,
    status = p_res ->> 'status',
    qty = (p_res ->> 'qty')::numeric,
    left_qty = (p_res ->> 'left_qty')::numeric,
    correlation_id = (p_res ->> 'correlation_id')::uuid,
    list_item_id = (p_res ->> 'list_item_id')::uuid,
    error_code = null,
    result = p_res,
    resolved_at = case when p_res ->> 'status' in ('unknown', 'bill_guard', 'held') then s.resolved_at else now() end,
    resolved_by = case when p_res ->> 'status' in ('unknown', 'bill_guard', 'held') then s.resolved_by else p_by end
   where s.id = p_id
$$;

revoke execute on function private.bin_display_name(text) from public, anon, authenticated;
revoke execute on function private.bin_store(uuid, uuid, bigint, bigint, timestamptz, boolean, text, text, integer, text, jsonb, text)
  from public, anon, authenticated;
revoke execute on function private.bin_restore(uuid, jsonb, uuid) from public, anon, authenticated;

-- ── rpc_scanner_sync ──────────────────────────────────────────────────────────
-- p (validated by Zod in the function, docs/bin-scanner/protocol.md):
--   { v, fw, epoch, boot, up, status{}, events[{seq, b, t, at?, type:'scan'|'undo', mode?, n?, code?}],
--     done[{id, ok, result?}], cat_v?, log[{t, m}]? }
create function public.rpc_scanner_sync(p_token_hash text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev      public.device%rowtype;
  v_epoch    bigint := (p ->> 'epoch')::bigint;
  v_boot     bigint := (p ->> 'boot')::bigint;
  v_up       bigint := (p ->> 'up')::bigint;
  v_floor    bigint;
  v_events   jsonb := coalesce(p -> 'events', '[]'::jsonb);
  v_log      jsonb := coalesce(p -> 'log', '[]'::jsonb);
  v_e        jsonb;
  v_seq      bigint;
  v_at       timestamptz;
  v_at_dev   timestamptz;
  v_est      boolean;
  v_type     text;
  v_mode     text;
  v_n        integer;
  v_code     text;
  v_res      jsonb;
  v_err      text;
  v_old      jsonb;
  v_target   public.bin_scan%rowtype;
  v_acked    jsonb := '[]'::jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_new      integer := 0;
  v_cmds     jsonb;
  v_cv       text;
  v_items    jsonb;
  v_tz       text;
  v_reason   text;
  v_paused_now boolean := false;
  v_alerts   jsonb := '[]'::jsonb;
begin
  select d.* into v_dev from public.scanner_token t join public.device d on d.id = t.device_id
   where t.token_hash = p_token_hash and d.revoked_at is null and d.kind = 'scanner'
   for update of d;
  if not found then
    raise exception 'unknown or revoked device' using errcode = '42501';
  end if;
  if jsonb_typeof(v_events) <> 'array' or jsonb_array_length(v_events) > 20 then
    raise exception 'at most 20 events' using errcode = '23514';
  end if;
  if (select count(*) from public.bin_scan s
       where s.device_id = v_dev.id and s.received_at > now() - interval '10 minutes')
     + jsonb_array_length(v_events) > 120 then
    raise exception 'too many scans' using errcode = 'GDRTE';
  end if;

  -- A new epoch means the scanner's flash was erased: its numbering starts again.
  v_floor := case when v_dev.epoch is not distinct from v_epoch then v_dev.seq_floor else 0 end;
  update public.device d set
    last_seen_at = now(),
    fw_version = left(p ->> 'fw', 32),
    epoch = v_epoch,
    seq_floor = v_floor,
    status = coalesce(p -> 'status', '{}'::jsonb) || jsonb_build_object('boot', v_boot, 'up', v_up)
   where d.id = v_dev.id;

  -- Commands the scanner finished.
  for v_e in select value from jsonb_array_elements(coalesce(p -> 'done', '[]'::jsonb)) loop
    update public.device_command c set
      status = case when (v_e ->> 'ok')::boolean then 'done' else 'failed' end,
      result = case when jsonb_typeof(v_e -> 'result') = 'object' then v_e -> 'result' end,
      done_at = now()
     where c.id = (v_e ->> 'id')::uuid and c.device_id = v_dev.id and c.status in ('queued', 'sent');
  end loop;

  -- Events, in the scanner's order.
  for v_e in select value from jsonb_array_elements(v_events) order by (value ->> 'seq')::bigint loop
    v_seq := (v_e ->> 'seq')::bigint;
    if v_seq <= v_floor then
      v_acked := v_acked || to_jsonb(v_seq);
      v_results := v_results || jsonb_build_object('seq', v_seq, 'status', 'pruned', 'replayed', true);
      continue;
    end if;
    select s.result into v_old from public.bin_scan s
     where s.device_id = v_dev.id and s.epoch = v_epoch and s.seq = v_seq;
    if found then
      v_acked := v_acked || to_jsonb(v_seq);
      v_results := v_results || (v_old || jsonb_build_object('seq', v_seq, 'replayed', true));
      continue;
    end if;

    -- When was it scanned? The scanner's clock if plausible, else estimated from its uptime.
    v_at_dev := case when v_e ? 'at' then to_timestamp((v_e ->> 'at')::numeric / 1000) end;
    if v_at_dev between now() - interval '30 days' and now() + interval '60 seconds' then
      v_at := least(v_at_dev, now());
      v_est := false;
    elsif (v_e ->> 'b')::bigint = v_boot and (v_e ->> 't')::bigint <= v_up then
      v_at := now() - make_interval(secs => (v_up - (v_e ->> 't')::bigint) / 1000.0);
      v_est := true;
    else
      v_at := now();
      v_est := true;
    end if;

    v_type := v_e ->> 'type';
    v_mode := case when v_type = 'scan' then v_e ->> 'mode' end;
    v_n := least(greatest(coalesce((v_e ->> 'n')::integer, 1), 1), 20);
    v_code := case when v_type = 'scan' then left(v_e ->> 'code', 96) end;
    v_err := null;

    begin
      if v_type = 'undo' then
        -- Only this scanner's own latest scan, and only for 10 minutes.
        select * into v_target from public.bin_scan s
         where s.device_id = v_dev.id and s.kind = 'scan' and s.status <> 'checked'
           and (s.epoch <> v_epoch or s.seq < v_seq)
         order by s.received_at desc, s.seq desc
         limit 1
         for update;
        if not found or v_target.at < v_at - interval '10 minutes' then
          v_res := jsonb_build_object('status', 'undo_none', 'reason', case when found then 'late' else 'nothing' end);
        else
          v_res := private.bin_undo(v_target, null);
        end if;
      elsif v_type = 'scan' and v_mode in ('use', 'add', 'open', 'waste', 'check')
            and v_code ~ '^[ -~]{1,96}$' then
        -- The limits, for scans that would change stock.
        if v_mode <> 'check' and v_dev.paused_at is null then
          v_reason := case
            when (select count(*) from public.bin_scan s
                   where s.device_id = v_dev.id and s.kind = 'scan' and s.mode <> 'check'
                     and s.at > v_at - interval '60 seconds' and s.at <= v_at + interval '60 seconds') >= 20
              then 'minute'
            when (select coalesce(sum(s.count), 0) from public.bin_scan s
                   where s.device_id = v_dev.id and s.kind = 'scan' and s.mode <> 'check'
                     and s.status in ('used', 'wasted', 'opened', 'added', 'moved', 'no_stock')
                     and s.received_at > now() - interval '24 hours') + v_n > 150
              then 'day'
            when v_mode = 'add'
                 and (select coalesce(sum(s.count), 0) from public.bin_scan s
                       where s.device_id = v_dev.id and s.kind = 'scan' and s.mode = 'add' and s.status = 'added'
                         and s.received_at > now() - interval '24 hours') + v_n > 50
              then 'add_day'
          end;
          if v_reason is not null then
            update public.device d set paused_at = now(), paused_reason = v_reason where d.id = v_dev.id;
            v_dev.paused_at := now();
            v_dev.paused_reason := v_reason;
            v_paused_now := true;
          end if;
        end if;
        if v_mode <> 'check' and v_dev.paused_at is not null then
          v_res := jsonb_build_object('status', 'held');
        else
          v_res := private.bin_apply(v_dev.household_id, v_mode, v_n, v_code, false);
        end if;
      else
        raise exception 'bad event' using errcode = '23514';
      end if;
    exception when others then
      -- Stored and acked anyway, so one bad event can never block the scanner's queue.
      v_res := jsonb_build_object('status', 'error', 'error', sqlstate);
      v_err := sqlstate;
    end;

    v_res := v_res || jsonb_build_object('dn', private.bin_display_name(coalesce(v_res ->> 'name', '')));
    perform private.bin_store(v_dev.household_id, v_dev.id, v_epoch, v_seq, v_at, v_est,
                              case when v_type = 'undo' then 'undo' else 'scan' end,
                              case when v_type = 'undo' then null
                                   when v_mode in ('use', 'add', 'open', 'waste', 'check') then v_mode else 'use' end, v_n,
                              case when v_type = 'undo' then null
                                   when v_code ~ '^[ -~]{1,96}$' then v_code else '?' end,
                              v_res, v_err);
    v_new := v_new + 1;
    v_acked := v_acked || to_jsonb(v_seq);
    v_results := v_results || (v_res || jsonb_build_object('seq', v_seq));
  end loop;
  if v_new > 0 then
    update public.device d set reading_count = d.reading_count + v_new where d.id = v_dev.id;
  end if;

  -- Its log lines (the Serial Monitor, once the box is closed): 7 days, newest 1,000.
  if jsonb_typeof(v_log) = 'array' and jsonb_array_length(v_log) between 1 and 30 then
    insert into public.device_log (household_id, device_id, at, boot, line)
    select v_dev.household_id, v_dev.id,
           case when (x ->> 't')::bigint between 0 and v_up
                then now() - make_interval(secs => (v_up - (x ->> 't')::bigint) / 1000.0)
                else now() end,
           v_boot,
           left(nullif(btrim(x ->> 'm'), ''), 160)
      from jsonb_array_elements(v_log) x
     where nullif(btrim(x ->> 'm'), '') is not null;
    delete from public.device_log l
     where l.device_id = v_dev.id
       and (l.at < now() - interval '7 days'
            or l.id < (select l2.id from public.device_log l2 where l2.device_id = v_dev.id
                        order by l2.id desc offset 999 limit 1));
  end if;

  -- Commands to run: old ones expire; queued and unconfirmed ones are (re)sent until done.
  update public.device_command c set status = 'expired'
   where c.device_id = v_dev.id and c.status in ('queued', 'sent') and c.created_at < now() - interval '2 hours';
  with sent as (
    update public.device_command c set status = 'sent', sent_at = coalesce(c.sent_at, now())
     where c.device_id = v_dev.id and c.status in ('queued', 'sent')
    returning c.id, c.command, c.args, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'command', s.command, 'args',
           case when s.command = 'ota' then
             coalesce((select jsonb_build_object('version', f.version, 'sha256', f.sha256, 'size', f.size, 'path', f.path)
                         from public.device_firmware f
                        where f.id = (s.args ->> 'firmware_id')::uuid and f.household_id = v_dev.household_id
                          and f.kind = 'scanner'), '{}'::jsonb)
           else s.args end) order by s.created_at), '[]'::jsonb)
    into v_cmds from sent s;

  -- The names it shows at once, before Gedara answers (and when offline): resent only on change.
  with cat as (
    select x.c, x.n from (
      select b.barcode as c, private.bin_display_name(p2.name) as n, 0 as o, b.created_at as at
        from public.product_barcode b
        join public.product p2 on p2.id = b.product_id and p2.household_id = b.household_id
       where b.household_id = v_dev.household_id and not p2.archived and b.barcode ~ '^[ -~]{4,64}$'
      union all
      select p3.code, private.bin_display_name(p3.name), 1, p3.created_at
        from public.product p3
       where p3.household_id = v_dev.household_id and not p3.archived
    ) x
    order by x.o, x.at desc
    limit 400
  )
  select coalesce(left(md5(string_agg(c.c || '|' || c.n, ',' order by c.c)), 8), '0'),
         coalesce(jsonb_agg(jsonb_build_array(c.c, c.n) order by c.c), '[]'::jsonb)
    into v_cv, v_items
    from cat c;

  select h.timezone into v_tz from public.household h where h.id = v_dev.household_id;

  -- Paused just now by a limit: the owner's phones hear of it at once (the function sends these
  -- with Web Push and never passes them on to the scanner).
  if v_paused_now then
    select coalesce(jsonb_agg(jsonb_build_object(
             'subscription_id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
             'title', left(v_dev.name || ' is paused', 120),
             'body', 'Too many scans in a short time. Nothing more changes until you look.',
             'tag', 'gedara-scanner-' || v_dev.id, 'url', '/settings/scanner/' || v_dev.id)), '[]'::jsonb)
      into v_alerts
      from public.push_subscription s
      join public.household_member m on m.user_id = s.user_id and m.household_id = s.household_id
     where s.household_id = v_dev.household_id and s.enabled and m.role = 'owner';
  end if;

  return jsonb_build_object(
    'acked', v_acked,
    'results', v_results,
    'commands', v_cmds,
    'alerts', v_alerts,
    'config', v_dev.settings || jsonb_build_object(
                'v', v_dev.settings_version,
                'tz_offset_min', round(extract(epoch from (now() at time zone coalesce(v_tz, 'Asia/Colombo'))
                                                        - (now() at time zone 'UTC')) / 60)),
    'cat', jsonb_build_object('v', v_cv) || case when (p ->> 'cat_v') is distinct from v_cv
                                                 then jsonb_build_object('items', v_items) else '{}'::jsonb end,
    'paused', v_dev.paused_at is not null,
    'paused_now', v_paused_now,
    'paused_reason', v_dev.paused_reason,
    'device', jsonb_build_object('id', v_dev.id, 'household_id', v_dev.household_id, 'name', v_dev.name),
    -- No polling (log budget): a heartbeat every 30 minutes; quicker only while someone waits for a command.
    'next_ms', case when v_dev.watch_until > now() or jsonb_array_length(v_cmds) > 0 then 5000 else 1800000 end,
    'server_time', round(extract(epoch from now()) * 1000));
end;
$$;

revoke execute on function public.rpc_scanner_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_scanner_sync(text, jsonb) to service_role;

-- ── rpc_bin_scan_undo: Undo on a scan's card ──────────────────────────────────
create function public.rpc_bin_scan_undo(p_scan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v   public.bin_scan%rowtype;
  v_r jsonb;
begin
  select * into v from public.bin_scan s where s.id = p_scan for update;
  if not found or not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_r := private.bin_undo(v, auth.uid());
  if v_r ->> 'status' = 'undo_none' then
    raise exception 'can''t undo (%)', v_r ->> 'reason' using errcode = 'GDUND';
  end if;
  return v_r;
end;
$$;

-- ── rpc_bin_scan_resolve: a scan that waited for a person ─────────────────────
-- p_choice 'apply': unknown → the barcode has been linked now: this scan and every other waiting
--   scan of the same code are applied in the order they were made; bill_guard → "add it anyway";
--   held → apply it. 'dismiss': drop it. Returns { status, applied }.
create function public.rpc_bin_scan_resolve(p_scan uuid, p_choice text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v       public.bin_scan%rowtype;
  w       public.bin_scan%rowtype;
  v_res   jsonb;
  v_n     integer := 0;
  v_first jsonb;
begin
  select * into v from public.bin_scan s where s.id = p_scan for update;
  if not found or not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_choice is null or p_choice not in ('apply', 'dismiss') then
    raise exception 'unknown choice' using errcode = '23514';
  end if;
  if v.status not in ('unknown', 'bill_guard', 'held') then
    raise exception 'already handled' using errcode = 'GDDEC';
  end if;

  if p_choice = 'dismiss' then
    update public.bin_scan s set status = 'dismissed', resolved_at = now(), resolved_by = auth.uid() where s.id = p_scan;
    return jsonb_build_object('status', 'dismissed', 'applied', 0);
  end if;

  for w in
    select * from public.bin_scan s
     where s.household_id = v.household_id
       and (s.id = v.id or (v.status = 'unknown' and s.status = 'unknown' and s.code = v.code))
     order by s.at, s.received_at, s.seq
     for update
  loop
    v_res := private.bin_apply(w.household_id, w.mode, w.count, w.code, w.status = 'bill_guard');
    if w.id = v.id then
      if v_res ->> 'status' = 'unknown' then
        raise exception 'link the barcode to a product first' using errcode = '23514';
      end if;
      v_first := v_res;
    end if;
    perform private.bin_restore(w.id, v_res, auth.uid());
    v_n := v_n + case when v_res ->> 'status' in ('unknown', 'bill_guard', 'held') then 0 else 1 end;
  end loop;
  return v_first || jsonb_build_object('applied', v_n);
end;
$$;

-- ── Pause / resume ────────────────────────────────────────────────────────────
-- Anyone who can write may pause (the safe direction); only the owner resumes.
create function public.rpc_scanner_pause(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select d.household_id into v_household from public.device d
   where d.id = p_id and d.kind = 'scanner' and d.revoked_at is null;
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.device d set paused_at = coalesce(d.paused_at, now()), paused_reason = coalesce(d.paused_reason, 'manual'),
                             settings_version = d.settings_version + 1
   where d.id = p_id;
end;
$$;

-- p_held: 'apply' the scans kept while it was paused (in order), 'drop' them, or 'keep' them waiting.
create function public.rpc_scanner_resume(p_id uuid, p_held text default 'keep')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev public.device%rowtype;
  w     public.bin_scan%rowtype;
  v_res jsonb;
  v_n   integer := 0;
begin
  select * into v_dev from public.device d where d.id = p_id and d.kind = 'scanner' and d.revoked_at is null for update;
  if not found or not private.is_owner(v_dev.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_held is null or p_held not in ('apply', 'drop', 'keep') then
    raise exception 'unknown choice' using errcode = '23514';
  end if;
  update public.device d set paused_at = null, paused_reason = null, settings_version = d.settings_version + 1
   where d.id = p_id;

  if p_held = 'drop' then
    update public.bin_scan s set status = 'dismissed', resolved_at = now(), resolved_by = auth.uid()
     where s.device_id = p_id and s.status = 'held';
    get diagnostics v_n = row_count;
  elsif p_held = 'apply' then
    for w in
      select * from public.bin_scan s where s.device_id = p_id and s.status = 'held'
       order by s.at, s.received_at, s.seq for update
    loop
      begin
        v_res := private.bin_apply(w.household_id, w.mode, w.count, w.code, false);
      exception when others then
        v_res := jsonb_build_object('status', 'error', 'error', sqlstate);
      end;
      perform private.bin_restore(w.id, v_res, auth.uid());
      v_n := v_n + 1;
    end loop;
  end if;
  return jsonb_build_object('held', v_n);
end;
$$;

-- ── rpc_scanner_undo_since: take back everything a scanner did since a moment (owner) ──
create function public.rpc_scanner_undo_since(p_id uuid, p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  w        public.bin_scan%rowtype;
  v_r      jsonb;
  v_undone integer := 0;
  v_failed integer := 0;
begin
  select d.household_id into v_household from public.device d where d.id = p_id and d.kind = 'scanner';
  if v_household is null or not private.is_owner(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_since is null or p_since < now() - interval '30 days' then
    raise exception 'at most 30 days back' using errcode = '23514';
  end if;
  for w in
    select * from public.bin_scan s
     where s.device_id = p_id and s.household_id = v_household and s.kind = 'scan' and s.undone_at is null
       and s.received_at >= p_since
       and s.status in ('used', 'wasted', 'opened', 'added', 'moved', 'no_stock', 'unknown', 'bill_guard', 'held')
     order by s.received_at desc, s.seq desc
     for update
  loop
    v_r := private.bin_undo(w, auth.uid());
    if v_r ->> 'status' = 'undo' then
      v_undone := v_undone + 1;
    else
      v_failed := v_failed + 1;
    end if;
  end loop;
  return jsonb_build_object('undone', v_undone, 'failed', v_failed);
end;
$$;

-- ── rpc_bin_add_settle: a bill arrived for something the scanner's Add already put in ──
-- Called by the app right after a bill stocked the pantry. The bill's lot is the priced truth, so
-- for each product of this bill the packs that Add scans put in during the 3 days before the bill's
-- date (not yet matched to a bill, not undone) are taken off again as a count correction, at most
-- what the bill brought. One correlation id, so Undo puts them back.
-- Returns { correlation_id, items: [{ product_id, name, qty, unit }] }.
create function public.rpc_bin_add_settle(p_transaction uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx    public.money_transaction%rowtype;
  v_corr  uuid := gen_random_uuid();
  v_items jsonb := '[]'::jsonb;
  b       record;
  v_added numeric;
  v_take  numeric;
  t       record;
begin
  select * into v_tx from public.money_transaction x where x.id = p_transaction;
  if not found or not private.can_write(v_tx.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  for b in
    select k.product_id, sum(k.qty_initial) as qty, min(k.transaction_line_id::text)::uuid as line_id
      from public.stock_lot k
      join public.transaction_line l on l.id = k.transaction_line_id and l.household_id = k.household_id
     where l.transaction_id = p_transaction and k.household_id = v_tx.household_id and k.split_from_id is null
     group by k.product_id
  loop
    select coalesce(sum(s.qty), 0) into v_added
      from public.bin_scan s
     where s.household_id = v_tx.household_id and s.product_id = b.product_id and s.mode = 'add' and s.status = 'added'
       and s.undone_at is null and s.bill_line_id is null
       and s.at >= (v_tx.occurred_on - 3)::timestamp at time zone 'Asia/Colombo';
    v_take := least(v_added, b.qty, private.bin_left(v_tx.household_id, b.product_id));
    continue when v_take <= 0;
    select * into t from private.stock_take(v_tx.household_id, b.product_id, v_take, null, null, 'adjust', v_corr,
                                            'Already added by the bin scanner');
    update public.bin_scan s set bill_line_id = b.line_id
     where s.household_id = v_tx.household_id and s.product_id = b.product_id and s.mode = 'add' and s.status = 'added'
       and s.undone_at is null and s.bill_line_id is null
       and s.at >= (v_tx.occurred_on - 3)::timestamp at time zone 'Asia/Colombo';
    v_items := v_items || jsonb_build_object(
      'product_id', b.product_id, 'qty', t.taken,
      'name', (select p.name from public.product p where p.id = b.product_id),
      'unit', (select u.code from public.product p join public.unit u on u.id = p.stock_unit_id where p.id = b.product_id));
  end loop;

  return jsonb_build_object('correlation_id', case when jsonb_array_length(v_items) > 0 then v_corr end, 'items', v_items);
end;
$$;

revoke execute on function public.rpc_bin_scan_undo(uuid) from public, anon;
revoke execute on function public.rpc_bin_scan_resolve(uuid, text) from public, anon;
revoke execute on function public.rpc_scanner_pause(uuid) from public, anon;
revoke execute on function public.rpc_scanner_resume(uuid, text) from public, anon;
revoke execute on function public.rpc_scanner_undo_since(uuid, timestamptz) from public, anon;
revoke execute on function public.rpc_bin_add_settle(uuid) from public, anon;
grant execute on function public.rpc_bin_scan_undo(uuid) to authenticated;
grant execute on function public.rpc_bin_scan_resolve(uuid, text) to authenticated;
grant execute on function public.rpc_scanner_pause(uuid) to authenticated;
grant execute on function public.rpc_scanner_resume(uuid, text) to authenticated;
grant execute on function public.rpc_scanner_undo_since(uuid, timestamptz) to authenticated;
grant execute on function public.rpc_bin_add_settle(uuid) to authenticated;

update public.app_meta set value = '108' where key = 'schema_version';
