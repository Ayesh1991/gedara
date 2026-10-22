-- Phase 9 · 77 — OTP detector v2 + two new alert kinds.
--
-- private.sms_is_secret mirrors supabase/functions/_shared/sms/secret.ts (the one the parser, the
-- Edge Function and the AI gateway use): OTP / password / "don't share" wording in English, Sinhala
-- and Tamil, also glued to the code; and, failing closed, any 4–8-digit number left after the numbers
-- a bank alert explains (amounts, balances, dates, times, masked accounts, hotlines, bank ids) are
-- blanked out — also spaced, dashed, or written in Sinhala / Tamil / other digits. Keep both in step;
-- supabase/tests/database/sms_secret.test.sql runs the same corpus as apps/web/src/lib/sms/secret.test.ts.
--
-- Kinds: `refund` (money back on a card, e.g. a Seylan reversal) and `info` (a note with no money of
-- its own: instalment plans, statements, reminders, low-balance alerts).

-- Lower case, NFKC (full-width forms), invisible joiners removed, every decimal digit script → 0-9.
create or replace function private.sms_secret_norm(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(translate(
    regexp_replace(normalize(coalesce(p_text, ''), nfkc), '[­​-‏⁠﻿]', '', 'g'),
    (select string_agg(chr(z + d), '' order by z, d)
       from unnest(array[x'0660'::int, x'06F0'::int, x'07C0'::int, x'0966'::int, x'09E6'::int, x'0A66'::int,
                         x'0AE6'::int, x'0B66'::int, x'0BE6'::int, x'0C66'::int, x'0CE6'::int, x'0D66'::int,
                         x'0DE6'::int, x'0E50'::int, x'0ED0'::int, x'0F20'::int, x'1040'::int, x'17E0'::int]) z,
            generate_series(0, 9) d),
    repeat('0123456789', 18)))
$$;

create or replace function private.sms_is_secret(p_body text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_t   text := private.sms_secret_norm(p_body);
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
  v_t := regexp_replace(v_t, v_cur || '\.?\s*:?\s*(?:[0-9][0-9,]*(?:\.[0-9]{1,2})?|\.[0-9]{1,2})(?:\s*/=)?', ' ', 'g');
  v_t := regexp_replace(v_t, '[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{2}(?![0-9])', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2,4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{4}-[0-9]{2}-[0-9]{2}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}(?:st|nd|rd|th)?[\s-]*' || v_mon || '(?:[\s,-]*[0-9]{2,4})?\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y' || v_mon || '\s*[0-9]{1,2}(?:st|nd|rd|th)?,?\s*[0-9]{4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\y', ' ', 'g');
  v_t := regexp_replace(v_t, '[0-9]{4}(?:\s*[*x]{4}){2}\s*[0-9]{4}', ' ', 'g');
  v_t := regexp_replace(v_t, '(?:x-){2,}x?-?[0-9]{2,4}', ' ', 'g');
  v_t := regexp_replace(v_t, '[x*.#]{2,}\s?-?[0-9]{2,4}\y', ' ', 'g');
  v_t := regexp_replace(v_t, '\y(?:a/c|acc(?:ount)?|card)\.?\s*(?:no\.?|number|#)?\s*:?\s*[0-9]{7,}', ' ', 'g');
  v_t := regexp_replace(v_t, '\y(?:txn|trxn|ref(?:erence)?|reversal|receipt)\.?\s*(?:no\.?|number|#|id)?\s*[:(]?\s*[0-9]{9,}', ' ', 'g');
  v_t := regexp_replace(v_t, '\yhotline\s*:?\s*[0-9]{3,5}(?![0-9])', ' ', 'g');

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

revoke execute on function private.sms_secret_norm(text) from public, anon, authenticated;
revoke execute on function private.sms_is_secret(text) from public, anon, authenticated;

alter table public.sms_message drop constraint sms_message_kind_check;
alter table public.sms_message add constraint sms_message_kind_check
  check (kind in ('card_charge', 'card_payment', 'bank_debit', 'bank_credit', 'atm', 'refund', 'info', 'unknown'));

-- One-off: nothing stored may look like a code under the stricter check (none expected; the count is
-- printed so the push shows it).
do $$
declare
  v_n integer;
begin
  delete from public.sms_message s where private.sms_is_secret(s.body);
  get diagnostics v_n = row_count;
  raise notice 'sms_secret_v2: % stored alert(s) removed', v_n;
end;
$$;

update public.app_meta set value = '77' where key = 'schema_version';
