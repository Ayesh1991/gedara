-- Phase 2b · 20 — SMS inbox write RPCs
-- Ingest (Edge Function only for devices; signed-in users for SMS-backup files), then review:
-- link to an existing transaction, post a new one (source 'sms'), ignore, unlink.
-- All SECURITY DEFINER with explicit checks; composite FKs keep everything in one household.
--
-- Error codes the app maps to messages (as in migration 16, plus):
--   GDLNK  the SMS is already linked / ignored (someone reviewed it a moment ago)
--   GDRTE  a device sent too many messages too fast

-- ── rpc_save_transaction → private.save_transaction(p, source) ────────────────
-- Same body as migration 16; only the source of a NEW transaction is now a parameter so SMS posts
-- are marked 'sms'. The public RPC keeps its signature, grants and behaviour ('manual').
create function private.save_transaction(p jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := (p ->> 'household_id')::uuid;
  v_type      text := p ->> 'type';
  v_total     numeric := (p ->> 'total')::numeric;
  v_lines     jsonb := coalesce(p -> 'lines', '[]'::jsonb);
  v_id        uuid := (p ->> 'id')::uuid;
  v_fp        text;
  v_source    text;
  v_merchant  uuid;
  v_sum       numeric;
  v_fee       numeric := coalesce((p #>> '{fee,amount}')::numeric, 0);
  v_fee_id    uuid;
begin
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_source not in ('manual', 'sms') then
    raise exception 'unsupported source %', p_source using errcode = '23514';
  end if;
  if v_total is null then
    raise exception 'total is required' using errcode = '23514';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_type <> 'transfer') then
    raise exception 'only transfers can carry a fee' using errcode = '23514';
  end if;

  if v_type in ('expense', 'income', 'refund') then
    v_merchant := private.resolve_merchant(v_household, p ->> 'payee_text');
  end if;

  if v_id is null then
    v_fp := p ->> 'fingerprint';
    v_source := p_source;
    insert into public.money_transaction
      (household_id, type, account_id, to_account_id, merchant_id, payee_text, occurred_on, occurred_at,
       invoice_no, total, source, fingerprint, notes)
    values
      (v_household, v_type, (p ->> 'account_id')::uuid, (p ->> 'to_account_id')::uuid, v_merchant,
       nullif(btrim(p ->> 'payee_text'), ''), (p ->> 'occurred_on')::date, (p ->> 'occurred_at')::time,
       nullif(btrim(p ->> 'invoice_no'), ''), v_total, v_source, v_fp, nullif(btrim(p ->> 'notes'), ''))
    on conflict (household_id, fingerprint) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception 'already saved: %', v_fp using errcode = 'GDDUP';
    end if;
  else
    select t.fingerprint, t.source into v_fp, v_source from public.money_transaction t
     where t.id = v_id and t.household_id = v_household
     for update;
    if not found then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    update public.money_transaction t set
      type = v_type,
      account_id = (p ->> 'account_id')::uuid,
      to_account_id = (p ->> 'to_account_id')::uuid,
      merchant_id = v_merchant,
      payee_text = nullif(btrim(p ->> 'payee_text'), ''),
      occurred_on = (p ->> 'occurred_on')::date,
      occurred_at = (p ->> 'occurred_at')::time,
      invoice_no = nullif(btrim(p ->> 'invoice_no'), ''),
      total = v_total,
      notes = nullif(btrim(p ->> 'notes'), '')
     where t.id = v_id;
    delete from public.transaction_line l where l.transaction_id = v_id;
    delete from public.money_transaction f where f.related_id = v_id and f.household_id = v_household;
  end if;

  v_sum := private.insert_lines(v_household, v_id, v_fp, v_source, v_lines);
  perform private.check_lines(v_type, v_total, jsonb_array_length(v_lines), v_sum);

  -- A transfer's fee (e.g. the Rs 25 CEFT charge) is its own expense from the same account.
  if v_fee > 0 then
    insert into public.money_transaction
      (household_id, type, account_id, payee_text, occurred_on, occurred_at, total, source, fingerprint, related_id)
    values
      (v_household, 'expense', (p ->> 'account_id')::uuid, 'Transfer fee', (p ->> 'occurred_on')::date,
       (p ->> 'occurred_at')::time, v_fee, v_source, v_fp || '~fee', v_id)
    returning id into v_fee_id;
    insert into public.transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint)
    values (v_household, v_fee_id, 0, 'Transfer fee', (p #>> '{fee,category_id}')::uuid, v_fee, v_fp || '~fee-0-fee');
  end if;

  return jsonb_build_object('id', v_id, 'fingerprint', v_fp);
end;
$$;

revoke execute on function private.save_transaction(jsonb, text) from public, anon, authenticated;

create or replace function public.rpc_save_transaction(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.save_transaction(p, 'manual');
end;
$$;

-- ── Ingest helpers ────────────────────────────────────────────────────────────

-- Defence in depth: the phone and the Edge Function already drop these. Never store an OTP.
create function private.sms_is_secret(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_body ~* '(\motp\M|one[ -]?time|pass ?code|password|verification code|security code|\mpin\M|do not share|never share)'
$$;

-- Stores parsed messages for one household. p_messages (validated by the Edge Function with Zod):
-- [{ sender, body, received_at, fingerprint, parser?, parser_version?, kind, institution?, last_digits?,
--    amount?, currency?, balance_after?, merchant_text?, bank_txn_id?, occurred_on, occurred_at? }]
-- Returns { stored, duplicate, dropped }.
create function private.sms_store(p_household uuid, p_device uuid, p_channel text, p_messages jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m        jsonb;
  v_stored   integer := 0;
  v_dup      integer := 0;
  v_dropped  integer := 0;
  v_sender   text;
  v_body     text;
  v_at       timestamptz;
  v_digits   text;
  v_inst     text;
  v_account  uuid;
  v_id       uuid;
begin
  if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages) > 200 then
    raise exception 'messages must be an array of at most 200' using errcode = '23514';
  end if;

  for v_m in select value from jsonb_array_elements(p_messages) loop
    v_sender := btrim(v_m ->> 'sender');
    v_body := v_m ->> 'body';
    v_at := (v_m ->> 'received_at')::timestamptz;
    if v_body is null or private.sms_is_secret(v_body) or v_at > now() + interval '1 day' then
      v_dropped := v_dropped + 1;
      continue;
    end if;

    -- Duplicate: same fingerprint, same bank transaction id, or same sender + text within 24 h.
    if exists (
      select 1 from public.sms_message s
       where s.household_id = p_household
         and (s.fingerprint = v_m ->> 'fingerprint'
              or (s.sender = v_sender and s.bank_txn_id = v_m ->> 'bank_txn_id')
              or (s.sender = v_sender and s.body = v_body
                  and s.received_at between v_at - interval '24 hours' and v_at + interval '24 hours'))
    ) then
      v_dup := v_dup + 1;
      continue;
    end if;

    -- Institution + last digits → account (BOC savings "319" vs BOC card "8873"); last digits alone
    -- only when exactly one account matches.
    v_digits := v_m ->> 'last_digits';
    v_inst := v_m ->> 'institution';
    v_account := null;
    if v_digits is not null then
      select a.id into v_account from public.account a
       where a.household_id = p_household and not a.archived and not a.is_suspense and a.last4 = v_digits
         and (v_inst is null or lower(a.institution) = lower(v_inst))
       limit 1;
      if v_account is null then
        select min(a.id::text)::uuid into v_account from public.account a
         where a.household_id = p_household and not a.archived and not a.is_suspense and a.last4 = v_digits
        having count(*) = 1;
      end if;
    end if;

    insert into public.sms_message
      (household_id, device_id, channel, sender, received_at, body, fingerprint, parser, parser_version, kind,
       institution, last_digits, account_id, amount, currency, balance_after, merchant_text, bank_txn_id,
       occurred_on, occurred_at)
    values
      (p_household, p_device, p_channel, v_sender, v_at, v_body, v_m ->> 'fingerprint', v_m ->> 'parser',
       (v_m ->> 'parser_version')::integer, coalesce(v_m ->> 'kind', 'unknown'), v_inst, v_digits, v_account,
       (v_m ->> 'amount')::numeric, coalesce(v_m ->> 'currency', 'LKR'), (v_m ->> 'balance_after')::numeric,
       nullif(btrim(v_m ->> 'merchant_text'), ''), v_m ->> 'bank_txn_id',
       coalesce((v_m ->> 'occurred_on')::date, (v_at at time zone 'Asia/Colombo')::date),
       (v_m ->> 'occurred_at')::time)
    on conflict do nothing
    returning id into v_id;

    if v_id is null then
      v_dup := v_dup + 1;
    else
      v_stored := v_stored + 1;
    end if;
  end loop;

  return jsonb_build_object('stored', v_stored, 'duplicate', v_dup, 'dropped', v_dropped);
end;
$$;

revoke execute on function private.sms_is_secret(text) from public, anon, authenticated;
revoke execute on function private.sms_store(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ── rpc_sms_ingest_device: the Edge Function's device path (service_role only) ─
-- p_token_hash = sha256 hex of the X-Gedara-Device header. p_dropped / p_rejected_sender are what
-- the function filtered out before parsing (counted, never stored).
create function public.rpc_sms_ingest_device(p_token_hash text, p_messages jsonb, p_dropped integer default 0,
                                             p_rejected_sender text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device    public.sms_device;
  v_recent    integer;
  v_out       jsonb;
begin
  select * into v_device from public.sms_device d
   where d.token_hash = p_token_hash and d.revoked_at is null
   for update;
  if not found then
    raise exception 'unknown or revoked device' using errcode = '42501';
  end if;

  select count(*) into v_recent from public.sms_message s
   where s.household_id = v_device.household_id and s.device_id = v_device.id
     and s.created_at > now() - interval '10 minutes';
  if v_recent + jsonb_array_length(coalesce(p_messages, '[]'::jsonb)) > 60 then
    raise exception 'too many messages' using errcode = 'GDRTE';
  end if;

  v_out := private.sms_store(v_device.household_id, v_device.id, 'forwarder', coalesce(p_messages, '[]'::jsonb));

  update public.sms_device d set
    last_seen_at = now(),
    message_count = d.message_count + (v_out ->> 'stored')::integer,
    dropped_count = d.dropped_count + greatest(coalesce(p_dropped, 0), 0) + (v_out ->> 'dropped')::integer,
    last_rejected_sender = coalesce(left(p_rejected_sender, 40), d.last_rejected_sender),
    last_rejected_at = case when p_rejected_sender is not null then now() else d.last_rejected_at end
   where d.id = v_device.id;

  return v_out;
end;
$$;

revoke execute on function public.rpc_sms_ingest_device(text, jsonb, integer, text) from public, anon, authenticated;
grant execute on function public.rpc_sms_ingest_device(text, jsonb, integer, text) to service_role;

-- ── rpc_sms_import: SMS-backup file, as the signed-in user ────────────────────
create function public.rpc_sms_import(p_household uuid, p_messages jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.sms_store(p_household, null, 'backup', p_messages);
end;
$$;

-- ── Review helpers ────────────────────────────────────────────────────────────
-- Locks the given inbox rows, checks they are one household the caller can write, and that none is
-- already linked or ignored. Returns the household.
create function private.sms_lock_new(p_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
  v_busy      integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 10 then
    raise exception 'pick 1 to 10 messages' using errcode = '23514';
  end if;
  perform 1 from public.sms_message s where s.id = any (p_ids) for update;
  select min(s.household_id::text)::uuid, count(*), count(*) filter (where s.transaction_id is not null or s.ignored)
    into v_household, v_count, v_busy
    from public.sms_message s where s.id = any (p_ids)
   having count(distinct s.household_id) = 1;
  if v_household is null or v_count <> cardinality(p_ids) or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_busy > 0 then
    raise exception 'already reviewed' using errcode = 'GDLNK';
  end if;
  return v_household;
end;
$$;

revoke execute on function private.sms_lock_new(uuid[]) from public, anon, authenticated;

-- ── rpc_sms_link: these alerts ARE this existing transaction ──────────────────
-- A bill waiting in "Card — to be matched" moves to the card the alert names.
-- Returns { moved: boolean }.
create function public.rpc_sms_link(p_sms_ids uuid[], p_transaction uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := private.sms_lock_new(p_sms_ids);
  v_tx        public.money_transaction;
  v_suspense  boolean;
  v_target    uuid;
  v_moved     boolean := false;
begin
  select * into v_tx from public.money_transaction t
   where t.id = p_transaction and t.household_id = v_household
   for update;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select a.is_suspense into v_suspense from public.account a where a.id = v_tx.account_id;
  if v_suspense and v_tx.type in ('expense', 'income', 'refund') then
    select min(s.account_id::text)::uuid into v_target from public.sms_message s
     where s.id = any (p_sms_ids) and s.account_id is not null
    having count(distinct s.account_id) = 1;
    if v_target is not null then
      update public.money_transaction t set account_id = v_target where t.id = v_tx.id;
      v_moved := true;
    end if;
  end if;

  update public.sms_message s set transaction_id = v_tx.id, reviewed_by = auth.uid(), reviewed_at = now()
   where s.id = any (p_sms_ids);
  return jsonb_build_object('moved', v_moved);
end;
$$;

-- ── rpc_sms_post: create the transaction these alerts describe ────────────────
-- p = an rpc_save_transaction payload (expense / income / transfer with fee …) WITHOUT id.
-- Its fingerprint is the earliest alert's (line fingerprints must extend it); source is 'sms'.
-- Returns { id, fingerprint }.
create function public.rpc_sms_post(p_sms_ids uuid[], p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid := private.sms_lock_new(p_sms_ids);
  v_fp        text;
  v_out       jsonb;
begin
  if (p ->> 'household_id')::uuid is distinct from v_household or p ? 'id' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select s.fingerprint into v_fp from public.sms_message s
   where s.id = any (p_sms_ids) order by s.received_at, s.fingerprint limit 1;

  v_out := private.save_transaction(p || jsonb_build_object('fingerprint', v_fp), 'sms');

  update public.sms_message s set transaction_id = (v_out ->> 'id')::uuid, reviewed_by = auth.uid(), reviewed_at = now()
   where s.id = any (p_sms_ids);
  return v_out;
end;
$$;

-- ── rpc_sms_ignore / rpc_sms_unlink ───────────────────────────────────────────
-- Ignore (or un-ignore) alerts that aren't linked. Returns how many changed.
create function public.rpc_sms_ignore(p_ids uuid[], p_ignored boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
begin
  select min(s.household_id::text)::uuid into v_household from public.sms_message s
   where s.id = any (p_ids)
  having count(distinct s.household_id) = 1 and count(*) = cardinality(p_ids);
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.sms_message s where s.id = any (p_ids) and s.transaction_id is not null) then
    raise exception 'linked messages can''t be ignored' using errcode = 'GDLNK';
  end if;
  update public.sms_message s
     set ignored = coalesce(p_ignored, true),
         reviewed_by = case when coalesce(p_ignored, true) then auth.uid() end,
         reviewed_at = case when coalesce(p_ignored, true) then now() end
   where s.id = any (p_ids) and s.ignored is distinct from coalesce(p_ignored, true);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Undo a link (the transaction stays; delete it to undo a post). Returns how many changed.
create function public.rpc_sms_unlink(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_count     integer;
begin
  select min(s.household_id::text)::uuid into v_household from public.sms_message s
   where s.id = any (p_ids)
  having count(distinct s.household_id) = 1 and count(*) = cardinality(p_ids);
  if v_household is null or not private.can_write(v_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.sms_message s set transaction_id = null, reviewed_by = null, reviewed_at = null
   where s.id = any (p_ids) and s.transaction_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.rpc_sms_import(uuid, jsonb) from public, anon;
revoke execute on function public.rpc_sms_link(uuid[], uuid) from public, anon;
revoke execute on function public.rpc_sms_post(uuid[], jsonb) from public, anon;
revoke execute on function public.rpc_sms_ignore(uuid[], boolean) from public, anon;
revoke execute on function public.rpc_sms_unlink(uuid[]) from public, anon;
grant execute on function public.rpc_sms_import(uuid, jsonb) to authenticated;
grant execute on function public.rpc_sms_link(uuid[], uuid) to authenticated;
grant execute on function public.rpc_sms_post(uuid[], jsonb) to authenticated;
grant execute on function public.rpc_sms_ignore(uuid[], boolean) to authenticated;
grant execute on function public.rpc_sms_unlink(uuid[]) to authenticated;

update public.app_meta set value = '20' where key = 'schema_version';
