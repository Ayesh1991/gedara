-- Bin scanner · 113 — "near" mode: an IR sensor and a white LED (Didula, 2026-11-13)
-- In a dim kitchen the reader's own sensing mode noticed packs late. The scanner can now have an IR
-- obstacle sensor (says "something is in front") and a 1 W white LED driven by a transistor (lights
-- the pack while it reads). Two settings:
--   eye = 'near'   the IR sensor starts each read (the reader is in command mode)
--   light          the white LED is used while reading (default on); the firmware limits it to 4 s
--                  per pack and about 15 s in any minute
-- Same checks as migration 110, plus these two.

create or replace function private.scanner_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k not in ('volume', 'quiet_from', 'quiet_to', 'eye', 'eye_quiet', 'mode_s', 'buzzer', 'bright',
                           'night_off', 'keymap', 'sense', 'light')) = 0
     and (not p ? 'volume' or (jsonb_typeof(p -> 'volume') = 'number'
                               and (p ->> 'volume')::numeric between 0 and 100
                               and (p ->> 'volume')::numeric = trunc((p ->> 'volume')::numeric)))
     and (not p ? 'quiet_from' or coalesce(p ->> 'quiet_from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'quiet_to' or coalesce(p ->> 'quiet_to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'eye' or coalesce(p ->> 'eye', '') in ('sense', 'always', 'key', 'near'))
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
     and (not p ? 'light' or jsonb_typeof(p -> 'light') = 'boolean')
$$;

update public.app_meta set value = '113' where key = 'schema_version';
