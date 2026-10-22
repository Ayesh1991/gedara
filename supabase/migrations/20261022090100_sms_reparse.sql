-- Phase 9 · 78 — stored alerts follow parser and account changes.
--
-- Until now an alert was parsed and given its account once, on arrival: a better parser (v2: BOC
-- card payments, Seylan reversals, People's notes …) or an account added later (BOC ..708) never
-- reached the alerts already in the inbox.
--   * rpc_sms_reparse: the app (or, from 9b, the match-agent) re-parses alerts whose parser_version is
--     older with the shared TypeScript parser and sends the new fields; the database checks the stored
--     text again with the OTP detector, never lowers a version, and re-resolves the account.
--   * an account whose digits / institution / archive state change re-resolves the alerts that are
--     still waiting (trigger), so "BOC ..708" picks up its 17 alerts the moment it is created.
-- A reviewed (linked or ignored) alert keeps its account: what a person decided stays.

-- Same rule as private.sms_store: institution + last digits; last digits alone only when exactly one
-- account matches.
create or replace function private.sms_resolve_account(p_household uuid, p_institution text, p_digits text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_account uuid;
begin
  if p_digits is null then
    return null;
  end if;
  select a.id into v_account from public.account a
   where a.household_id = p_household and not a.archived and not a.is_suspense and a.last4 = p_digits
     and (p_institution is null or lower(a.institution) = lower(p_institution))
   order by a.created_at
   limit 1;
  if v_account is null then
    select min(a.id::text)::uuid into v_account from public.account a
     where a.household_id = p_household and not a.archived and not a.is_suspense and a.last4 = p_digits
    having count(*) = 1;
  end if;
  return v_account;
end;
$$;

revoke execute on function private.sms_resolve_account(uuid, text, text) from public, anon, authenticated;

-- p_rows: [{ id, parser, parser_version, kind, institution, last_digits, amount, currency, balance_after,
--            merchant_text, bank_txn_id, occurred_on, occurred_at, drop }]  (drop = 'promo' | … | null)
-- Returns { updated, ignored, removed, skipped }.
create function public.rpc_sms_reparse(p_household uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r        jsonb;
  v_s        public.sms_message;
  v_version  integer;
  v_updated  integer := 0;
  v_ignored  integer := 0;
  v_removed  integer := 0;
  v_skipped  integer := 0;
begin
  if not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'rows must be an array of at most 500' using errcode = '23514';
  end if;

  for v_r in select value from jsonb_array_elements(p_rows) loop
    select * into v_s from public.sms_message s
     where s.id = (v_r ->> 'id')::uuid and s.household_id = p_household
     for update;
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The stored text is checked again with today's detector, whatever the caller says.
    if private.sms_is_secret(v_s.body) then
      delete from public.sms_message s where s.id = v_s.id;
      v_removed := v_removed + 1;
      continue;
    end if;

    v_version := (v_r ->> 'parser_version')::integer;
    if v_version is null or v_version <= coalesce(v_s.parser_version, 0) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Now filtered out (e.g. a promotion): set aside unless a person already used it.
    if v_r ->> 'drop' is not null then
      update public.sms_message s
         set parser_version = v_version,
             ignored = case when s.transaction_id is null then true else s.ignored end,
             reviewed_by = case when s.transaction_id is null and not s.ignored then auth.uid() else s.reviewed_by end,
             reviewed_at = case when s.transaction_id is null and not s.ignored then now() else s.reviewed_at end
       where s.id = v_s.id;
      v_ignored := v_ignored + 1;
      continue;
    end if;

    begin
      update public.sms_message s
         set parser = v_r ->> 'parser',
             parser_version = v_version,
             kind = coalesce(v_r ->> 'kind', 'unknown'),
             institution = v_r ->> 'institution',
             last_digits = v_r ->> 'last_digits',
             amount = (v_r ->> 'amount')::numeric,
             currency = coalesce(v_r ->> 'currency', 'LKR'),
             balance_after = (v_r ->> 'balance_after')::numeric,
             merchant_text = nullif(btrim(v_r ->> 'merchant_text'), ''),
             bank_txn_id = v_r ->> 'bank_txn_id',
             occurred_on = coalesce((v_r ->> 'occurred_on')::date, s.occurred_on),
             occurred_at = (v_r ->> 'occurred_at')::time,
             account_id = case
               when s.transaction_id is null and not s.ignored
                 then private.sms_resolve_account(p_household, v_r ->> 'institution', v_r ->> 'last_digits')
               else coalesce(s.account_id,
                             private.sms_resolve_account(p_household, v_r ->> 'institution', v_r ->> 'last_digits'))
             end
       where s.id = v_s.id;
    exception when unique_violation then
      -- the same bank id is already on another alert: keep this one, without the id
      update public.sms_message s
         set parser = v_r ->> 'parser', parser_version = v_version, kind = coalesce(v_r ->> 'kind', 'unknown'),
             last_digits = v_r ->> 'last_digits', amount = (v_r ->> 'amount')::numeric,
             currency = coalesce(v_r ->> 'currency', 'LKR'), balance_after = (v_r ->> 'balance_after')::numeric,
             merchant_text = nullif(btrim(v_r ->> 'merchant_text'), '')
       where s.id = v_s.id;
    end;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('updated', v_updated, 'ignored', v_ignored, 'removed', v_removed, 'skipped', v_skipped);
end;
$$;

revoke execute on function public.rpc_sms_reparse(uuid, jsonb) from public, anon;
grant execute on function public.rpc_sms_reparse(uuid, jsonb) to authenticated;

-- An account's digits / institution / archive state changed → the waiting alerts look again.
create function private.account_sms_resolve()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.sms_message s
     set account_id = private.sms_resolve_account(s.household_id, s.institution, s.last_digits)
   where s.household_id = new.household_id
     and s.transaction_id is null and not s.ignored and s.last_digits is not null
     and s.account_id is distinct from private.sms_resolve_account(s.household_id, s.institution, s.last_digits);
  return null;
end;
$$;

revoke execute on function private.account_sms_resolve() from public, anon, authenticated;

create trigger account_sms_resolve
  after insert or update of last4, institution, archived, is_suspense on public.account
  for each row execute function private.account_sms_resolve();

update public.app_meta set value = '78' where key = 'schema_version';
