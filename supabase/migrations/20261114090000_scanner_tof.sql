-- Bin scanner · 114 — a distance sensor (VL53L0X) and a light that comes on only when needed
-- (Didula, 2026-11-14). The IR sensor depended on the room light and the pack's colour; the distance
-- sensor measures with its own laser. And the white LED now has three choices instead of on/off:
--   eye = 'tof'          the distance sensor starts each read (falls back to the reader's own
--                        sensing while the sensor isn't found)
--   light_mode           'auto' (the scanner learns when the LED helps: it reads without it first
--                        and lights it after a short learned wait, or at once when it is usually
--                        needed at this hour) · 'always' · 'off'. The old "light" (on/off) is still
--                        accepted and means always / off.
--   range_mm             a pack counts within this distance, 120–400 mm (default 300)
-- Same checks as migration 113, plus these.

create or replace function private.scanner_settings_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k not in ('volume', 'quiet_from', 'quiet_to', 'eye', 'eye_quiet', 'mode_s', 'buzzer', 'bright',
                           'night_off', 'keymap', 'sense', 'light', 'light_mode', 'range_mm')) = 0
     and (not p ? 'volume' or (jsonb_typeof(p -> 'volume') = 'number'
                               and (p ->> 'volume')::numeric between 0 and 100
                               and (p ->> 'volume')::numeric = trunc((p ->> 'volume')::numeric)))
     and (not p ? 'quiet_from' or coalesce(p ->> 'quiet_from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'quiet_to' or coalesce(p ->> 'quiet_to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     and (not p ? 'eye' or coalesce(p ->> 'eye', '') in ('sense', 'always', 'key', 'near', 'tof'))
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
     and (not p ? 'light_mode' or coalesce(p ->> 'light_mode', '') in ('auto', 'always', 'off'))
     and (not p ? 'range_mm' or (jsonb_typeof(p -> 'range_mm') = 'number'
                                 and (p ->> 'range_mm')::numeric between 120 and 400
                                 and (p ->> 'range_mm')::numeric = trunc((p ->> 'range_mm')::numeric)))
$$;

update public.app_meta set value = '114' where key = 'schema_version';
