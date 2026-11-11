-- Phase 11 · 110 — how keenly the bin scanner's reader senses a pack (Didula, 2026-11-11)
-- In its sensing mode the GM861S wakes when the camera picture changes; in a dim kitchen a pack
-- changes it too little and the reader wakes late or not at all. A new setting `sense` picks the
-- reader's own sensitivity: normal (its factory value) · high · max (as keen as it goes). The lamp
-- still lights only while it reads, so a keener reader does not burn its LED: the firmware also
-- shortens each read to 2 s at high and max.
-- Same checks as migration 105, plus the new key.

create or replace function private.scanner_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k not in ('volume', 'quiet_from', 'quiet_to', 'eye', 'eye_quiet', 'mode_s', 'buzzer', 'bright',
                           'night_off', 'keymap', 'sense')) = 0
     and (not p ? 'volume' or (jsonb_typeof(p -> 'volume') = 'number'
                               and (p ->> 'volume')::numeric between 0 and 100
                               and (p ->> 'volume')::numeric = trunc((p ->> 'volume')::numeric)))
     and (not p ? 'quiet_from' or coalesce(p ->> 'quiet_from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'quiet_to' or coalesce(p ->> 'quiet_to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'eye' or coalesce(p ->> 'eye', '') in ('sense', 'always', 'key'))
     and (not p ? 'eye_quiet' or coalesce(p ->> 'eye_quiet', '') in ('same', 'key'))
     and (not p ? 'mode_s' or (jsonb_typeof(p -> 'mode_s') = 'number'
                               and (p ->> 'mode_s')::numeric between 10 and 120
                               and (p ->> 'mode_s')::numeric = trunc((p ->> 'mode_s')::numeric)))
     and (not p ? 'buzzer' or coalesce(p ->> 'buzzer', '') in ('passive', 'active'))
     and (not p ? 'bright' or (jsonb_typeof(p -> 'bright') = 'number'
                               and (p ->> 'bright')::numeric between 0 and 100
                               and (p ->> 'bright')::numeric = trunc((p ->> 'bright')::numeric)))
     and (not p ? 'night_off' or jsonb_typeof(p -> 'night_off') = 'boolean')
     -- every one of the 16 keys exactly once
     and (not p ? 'keymap' or (coalesce(p ->> 'keymap', '') ~ '^[0-9A-D*#]{16}$'
                               and (select count(distinct c) from regexp_split_to_table(p ->> 'keymap', '') c) = 16))
     and (not p ? 'sense' or coalesce(p ->> 'sense', '') in ('normal', 'high', 'max'))
$$;

update public.app_meta set value = '110' where key = 'schema_version';
