-- Phase 2 · 11 — units (MASTER_PLAN §3.2)
-- System units only for now (household_id null, read-only to clients) so bill lines can store a
-- normalised quantity + price per base unit (g / ml / pcs …) from day one. Phase 3 adds household
-- units and product-specific conversions ("1 pack = 400 g").

create table public.unit (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid references public.household (id) on delete cascade,  -- null = system unit
  code         text not null check (length(btrim(code)) between 1 and 16),
  name         text not null check (length(btrim(name)) between 1 and 40),
  dimension    text not null check (dimension in ('mass', 'volume', 'count', 'energy', 'length', 'other')),
  to_base      numeric(14,6) not null check (to_base > 0),   -- g = 1, kg = 1000 (base: g / ml / pcs / kWh / m)
  aliases      text[] not null default '{}',                 -- lower-case spellings seen on bills: 'pc', 'kgs'
  created_at   timestamptz not null default now()
);

-- One code per scope: system codes are global, household codes unique within the household.
create unique index unit_system_code_idx on public.unit (lower(code)) where household_id is null;
create unique index unit_household_code_idx on public.unit (household_id, lower(code)) where household_id is not null;

insert into public.unit (household_id, code, name, dimension, to_base, aliases) values
  (null, 'g',     'gram',        'mass',   1,    '{gram,grams,gm,gms,gr}'),
  (null, 'kg',    'kilogram',    'mass',   1000, '{kgs,kilo,kilos,kilogram,kilograms}'),
  (null, 'ml',    'millilitre',  'volume', 1,    '{mls,millilitre,milliliter}'),
  (null, 'L',     'litre',       'volume', 1000, '{l,ltr,ltrs,litre,litres,liter,liters}'),
  (null, 'pcs',   'piece',       'count',  1,    '{pc,piece,pieces,nos,no,ea,each,unit,units,tabs,tab}'),
  (null, 'pack',  'pack',        'other',  1,    '{pkt,packet,packets,packs,pouch,tub}'),
  (null, 'bottle','bottle',      'other',  1,    '{btl,bottles}'),
  (null, 'kWh',   'kilowatt-hour','energy',1,    '{kwh,units (kwh)}'),
  (null, 'm³',    'cubic metre', 'volume', 1000000, '{m3,cubic metre,cubic meter}'),
  (null, 'm',     'metre',       'length', 1,    '{meter,metre,meters,metres,mtr}'),
  (null, 'month', 'month',       'other',  1,    '{months,mo}');

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.unit enable row level security;

revoke all on table public.unit from anon, authenticated;
grant select on table public.unit to authenticated;

create policy unit_select on public.unit
  for select to authenticated
  using (household_id is null or private.is_member(household_id));

update public.app_meta set value = '11' where key = 'schema_version';
