-- Phase 9 · 89 — BOC Flex Tap & Pay and wallet top-ups (9b.2).
--
-- * private.sms_is_secret_from mirrors supabase/functions/_shared/sms/secret.ts: BOCONLINE's Tap & Pay
--   reference ("Ref: VC_7760QQS8") is explained for that sender only, and only with letters in it. Every
--   BOCONLINE OTP ("Please use OTP …", "… as your OTP for BOC Flex Wallet …") is still dropped by its words.
-- * match_suggestion gains the task sms_topup: a BOC balance that dropped more than its alerts explain is
--   proposed as a top-up of the BOC Flex wallet (that top-up sends no SMS); a person books it.

create or replace function private.sms_is_secret_from(p_sender text, p_body text)
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
  -- BOC Flex Tap & Pay "Ref: VC_7760QQS8" (9b.2), from BOCONLINE only; letters AND digits, so
  -- "Ref: VC_482913" stays a code
  if v_key = 'BOCONLINE' then
    v_t := regexp_replace(v_t, '\yref\s*:?\s*vc_(?=[a-z0-9]*[a-z])(?=[a-z0-9]*[0-9])[a-z0-9]{6,12}\y', ' ', 'g');
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

alter table public.match_suggestion drop constraint match_suggestion_task_check;
alter table public.match_suggestion add constraint match_suggestion_task_check
  check (task in ('line_product', 'line_category', 'line_thing', 'sms_category', 'sms_link', 'sms_rebook', 'sms_recategorise', 'sms_topup'));

update public.app_meta set value = '89' where key = 'schema_version';
