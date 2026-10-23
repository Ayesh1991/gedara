-- Phase 9 · 85 — payees' confirmations as evidence; the OTP check knows the sender (9b.1).
--
-- * private.sms_is_secret_from(sender, body) mirrors supabase/functions/_shared/sms/secret.ts v3:
--   year-first dates (2026/09/22) and a single-X mask (X2229) are explained; a currency word must stand
--   on its own ("offers. 482913" was read as "Rs 482913" — fixed); Sampath's fixed closing line
--   "Get protected -Do not Share OTP" is set aside; SAMPATHTXN's own references ("for
--   DORMANT_CHG_052026") are explained for that sender only. private.sms_is_secret(body) stays the
--   strictest form (no sender). Storing and re-checking alerts now pass the sender.
-- * kind `receipt`: SLTBILL / LECO BILL / SLT-Mobitel / Dialog (5555) / Star Points confirm a payment
--   (payee, amount, time) and never become money themselves.
-- * payee_category: the household's own "this payee is that category" (SLT bill → Internet …); Gedara
--   has defaults in the app and this table overrides them.

create function private.sms_is_secret_from(p_sender text, p_body text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Sampath's fixed closing line is set aside (exact wording, only at the very end)
  v_t   text := regexp_replace(private.sms_secret_norm(p_body), '\s*get protected\s*-\s*do not share otp\.?\s*$', '');
  v_key constant text := upper(regexp_replace(coalesce(p_sender, ''), '[^A-Za-z0-9]', '', 'g'));
  v_mon constant text := '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  v_cur constant text := '(?:lkr|rs|usd|eur|gbp|sgd|aud|inr|aed|jpy|cny|රු|ரூ|₨)';
  v_m   text[];
begin
  -- 1. Words (English must not sit inside a longer word, but may touch the code).
  if v_t ~ ('(?<![a-z])(?:otps?|one ?-?time|pass ?-?code|pass ?-?word|passwd|m?-?pin|t-?pin|e-?pin|pin ?no|tac|cvv|cvc'
            || '|verification|verify|security code|secret code|access code|activation code'
            || '|auth(?:entication|ori[sz]ation)? code|approval code|login code|sign[ -]?in code'
            || '|do ?not share|don''?t share|never share|not to share|never disclose|do not disclose)(?![a-z])')
     or v_t ~ '(?<![a-z])codes?(?![a-z])(?:\s*(?:is|:|-|=|#))?\s*[0-9]'
     or v_t ~ '\y(?:valid|expires?|expiring)\s+(?:for|in|within)\s+[0-9]+\s*(?:min|mins|minutes?|sec|secs|seconds?)\y'
     or v_t ~ ('(?:මුරපද|මුර පද|එක් වරක්|එක්වරක්|එක් වරක|රහස්|රහස|කේත|සතයාපන|සත්යාපන|තහවුරු කිරීමේ අංක'
               || '|තහවුරු කිරීමේ කේත|බෙදා නොග|බෙදා නොදෙන්න|කිසිවෙකු සමඟ|කිසිවෙකුට|පින් අංක'
               || '|கடவுச்சொல்|கடவுச் சொல்|ஒருமுறை|ஒரு முறை|குறியீடு|சரிபார்ப்பு|இரகசிய|ரகசிய|பகிர வேண்டாம்'
               || '|பகிர்ந்து கொள்ள வேண்டாம்)') then
    return true;
  end if;

  -- 2. Blank out what a bank alert explains (same order as secret.ts) …
  -- (the currency word on its own: "offers. 482913" is not "Rs 482913")
  v_t := regexp_replace(v_t, '(?<![a-z])' || v_cur || '\.?\s*:?\s*(?:[0-9][0-9,]*(?:\.[0-9]{1,2})?|\.[0-9]{1,2})(?:\s*/=)?', ' ', 'g');
  v_t := regexp_replace(v_t, '[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{2}(?![0-9])', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2,4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{4}-[0-9]{2}-[0-9]{2}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{4}[/.][0-9]{1,2}[/.][0-9]{1,2}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}(?:st|nd|rd|th)?[\s-]*' || v_mon || '(?:[\s,-]*[0-9]{2,4})?\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y' || v_mon || '\s*[0-9]{1,2}(?:st|nd|rd|th)?,?\s*[0-9]{4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\y', ' ', 'g');
  v_t := regexp_replace(v_t, '[0-9]{4}(?:\s*[*x]{4}){2}\s*[0-9]{4}', ' ', 'g');
  v_t := regexp_replace(v_t, '(?:x-){2,}x?-?[0-9]{2,4}', ' ', 'g');
  v_t := regexp_replace(v_t, '[x*.#]{2,}\s?-?[0-9]{2,4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '(?<![a-z0-9])x[0-9]{3,4}(?![0-9])', ' ', 'g');
  v_t := regexp_replace(v_t, '\y(?:a/c|acc(?:ount)?|card)\.?\s*(?:no\.?|number|#)?\s*:?\s*[0-9]{7,}', ' ', 'g');
  v_t := regexp_replace(v_t, '\y(?:txn|trxn|ref(?:erence)?|reversal|receipt)\.?\s*(?:no\.?|number|#|id)?\s*[:(]?\s*[0-9]{9,}', ' ', 'g');
  v_t := regexp_replace(v_t, '\yhotline\s*:?\s*[0-9]{3,5}(?![0-9])', ' ', 'g');
  -- SAMPATHTXN's own references ("for DORMANT_CHG_052026"), from that sender only
  if v_key = 'SAMPATHTXN' then
    v_t := regexp_replace(v_t, '\yfor\s+[a-z]{2,}(?:_[a-z]{2,})+_[0-9]{4,8}\y', ' ', 'g');
  end if;

  -- … then any 4–8-digit number left is a code: in one piece, or in small spaced / dashed groups.
  if v_t ~ '(?<![0-9-])[0-9]{4,8}(?![0-9-])' then
    return true;
  end if;
  for v_m in
    select regexp_matches(v_t, '(?<![0-9.,])(?<![0-9][ .-])[0-9]{1,3}(?:[ .-][0-9]{1,3}){1,7}(?![ .-]?[0-9])', 'g')
  loop
    if length(regexp_replace(v_m[1], '[^0-9]', '', 'g')) between 4 and 8 then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function private.sms_is_secret(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.sms_is_secret_from(null, p_body)
$$;

revoke execute on function private.sms_is_secret_from(text, text) from public, anon, authenticated;
revoke execute on function private.sms_is_secret(text) from public, anon, authenticated;

create or replace function private.sms_store(p_household uuid, p_device uuid, p_channel text, p_messages jsonb)
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
    if v_body is null or private.sms_is_secret_from(v_sender, v_body) or v_at > now() + interval '1 day' then
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

create or replace function public.rpc_sms_reparse(p_household uuid, p_rows jsonb)
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
    if private.sms_is_secret_from(v_s.sender, v_s.body) then
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

alter table public.sms_message drop constraint sms_message_kind_check;
alter table public.sms_message add constraint sms_message_kind_check
  check (kind in ('card_charge', 'card_payment', 'bank_debit', 'bank_credit', 'atm', 'refund', 'info', 'receipt', 'unknown'));

-- ── Payee → category (the household's overrides of the app's defaults) ───────
create table public.payee_category (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  payee_norm   text not null check (length(payee_norm) between 1 and 80 and payee_norm = private.bill_name_norm(payee_norm)),
  category_id  uuid not null,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  unique (household_id, payee_norm),
  foreign key (household_id, category_id) references public.category (household_id, id) on delete cascade
);

alter table public.payee_category enable row level security;
revoke all on table public.payee_category from anon, authenticated;
grant select, delete on table public.payee_category to authenticated;
create policy payee_category_select on public.payee_category for select to authenticated using (private.is_member(household_id));
create policy payee_category_delete on public.payee_category for delete to authenticated using (private.can_write(household_id));

create function public.rpc_payee_category_save(p_household uuid, p_payee text, p_category uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.bill_name_norm(p_payee) = '' then
    raise exception 'payee missing' using errcode = '22023';
  end if;
  insert into public.payee_category as c (household_id, payee_norm, category_id, updated_by)
  values (p_household, left(private.bill_name_norm(p_payee), 80), p_category, auth.uid())
  on conflict (household_id, payee_norm) do update
    set category_id = excluded.category_id, updated_by = auth.uid(), updated_at = now();
end;
$$;

revoke execute on function public.rpc_payee_category_save(uuid, text, uuid) from public, anon;
grant execute on function public.rpc_payee_category_save(uuid, text, uuid) to authenticated;

update public.app_meta set value = '85' where key = 'schema_version';
