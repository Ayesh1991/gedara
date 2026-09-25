-- Phase 5 · 34 — tags, category field templates, document titles (MASTER_PLAN §3.2, §3.5, §3.7)
-- Tags are Homebox "labels" (free, many per asset). Field templates give a category its own extra
-- fields ("Electronics" → IMEI, storage); values live in `asset.custom` and are validated in the web
-- app against the templates of the asset's category and its parent. Documents (receipts, warranty
-- cards, manuals) keep their original file name in `attachment.title`.

-- ── tag ───────────────────────────────────────────────────────────────────────
create table public.tag (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 40),
  color        text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at   timestamptz not null default now(),
  unique (household_id, id)
);

create unique index tag_name_idx on public.tag (household_id, lower(btrim(name)));

create function private.tag_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  return new;
end;
$$;

create trigger tag_tidy
  before insert or update on public.tag
  for each row execute function private.tag_tidy();

create table public.asset_tag (
  household_id uuid not null references public.household (id) on delete cascade,
  asset_id     uuid not null,
  tag_id       uuid not null,
  primary key (asset_id, tag_id),
  foreign key (household_id, asset_id) references public.asset (household_id, id) on delete cascade,
  foreign key (household_id, tag_id) references public.tag (household_id, id) on delete cascade
);

create index asset_tag_tag_idx on public.asset_tag (household_id, tag_id);

-- ── category_field ────────────────────────────────────────────────────────────
create table public.category_field (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.household (id) on delete cascade,
  category_id  uuid not null,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label        text not null check (length(btrim(label)) between 1 and 60),
  type         text not null check (type in ('text', 'number', 'boolean', 'date', 'select', 'url')),
  options      text[] check (cardinality(options) <= 30),
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (category_id, key),
  foreign key (household_id, category_id) references public.category (household_id, id) on delete cascade,
  check ((type = 'select') = (options is not null and cardinality(options) > 0))
);

create index category_field_household_idx on public.category_field (household_id, category_id);

create function private.category_field_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label := btrim(new.label);
  if new.options is not null then
    -- Trimmed, blanks dropped, case-insensitive duplicates dropped, first-seen order kept.
    select array_agg(s.o order by s.n) into new.options
      from (select distinct on (lower(btrim(u.o))) btrim(u.o) as o, u.n
              from unnest(new.options) with ordinality as u (o, n)
             where btrim(u.o) <> ''
             order by lower(btrim(u.o)), u.n) s;
    if coalesce(cardinality(new.options), 0) = 0 then
      new.options := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger category_field_tidy
  before insert or update on public.category_field
  for each row execute function private.category_field_tidy();

-- ── attachment.title ──────────────────────────────────────────────────────────
alter table public.attachment add column title text check (length(title) <= 120);

-- ── RLS + privileges ──────────────────────────────────────────────────────────
alter table public.tag enable row level security;
alter table public.asset_tag enable row level security;
alter table public.category_field enable row level security;

revoke all on table public.tag from anon, authenticated;
revoke all on table public.asset_tag from anon, authenticated;
revoke all on table public.category_field from anon, authenticated;

grant select, delete on table public.tag to authenticated;
grant insert (id, household_id, name, color) on table public.tag to authenticated;
grant update (name, color) on table public.tag to authenticated;

grant select, delete on table public.asset_tag to authenticated;
grant insert (household_id, asset_id, tag_id) on table public.asset_tag to authenticated;

-- A field's key and type are fixed once created (stored values depend on them); relabel instead.
grant select, delete on table public.category_field to authenticated;
grant insert (id, household_id, category_id, key, label, type, options, sort) on table public.category_field to authenticated;
grant update (label, options, sort) on table public.category_field to authenticated;

grant insert (title) on table public.attachment to authenticated;
grant update (title) on table public.attachment to authenticated;

create policy tag_select on public.tag for select to authenticated using (private.is_member(household_id));
create policy tag_insert on public.tag for insert to authenticated with check (private.can_write(household_id));
create policy tag_update on public.tag for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy tag_delete on public.tag for delete to authenticated using (private.can_write(household_id));

create policy asset_tag_select on public.asset_tag for select to authenticated using (private.is_member(household_id));
create policy asset_tag_insert on public.asset_tag for insert to authenticated with check (private.can_write(household_id));
create policy asset_tag_delete on public.asset_tag for delete to authenticated using (private.can_write(household_id));

create policy category_field_select on public.category_field for select to authenticated
  using (private.is_member(household_id));
create policy category_field_insert on public.category_field for insert to authenticated
  with check (private.can_write(household_id));
create policy category_field_update on public.category_field for update to authenticated
  using (private.can_write(household_id)) with check (private.can_write(household_id));
create policy category_field_delete on public.category_field for delete to authenticated
  using (private.can_write(household_id));

-- ── Starter templates for households that have the seeded Non-consumables tree ──
insert into public.category_field (household_id, category_id, key, label, type, options, sort)
select c.household_id, c.id, f.key, f.label, f.type, f.options, f.sort
  from public.category c
  join public.category p on p.id = c.parent_id and p.household_id = c.household_id and p.key = 'nonconsumable'
  join (values
    ('electronics',      'imei',         'IMEI',             'text',   null::text[], 1),
    ('electronics',      'storage',      'Storage',          'text',   null,         2),
    ('electronics',      'colour',       'Colour',           'text',   null,         3),
    ('home appliances',  'power_w',      'Power (W)',        'number', null,         1),
    ('home appliances',  'energy_stars', 'Energy stars',     'number', null,         2),
    ('home appliances',  'capacity',     'Capacity',         'text',   null,         3),
    ('furniture',        'material',     'Material',         'text',   null,         1),
    ('books',            'author',       'Author',           'text',   null,         1),
    ('books',            'isbn',         'ISBN',             'text',   null,         2),
    ('tools & hardware', 'power_source', 'Power source',     'select', array['Mains', 'Battery', 'Petrol', 'Manual'], 1)
  ) as f (sub, key, label, type, options, sort) on f.sub = lower(c.name)
on conflict (category_id, key) do nothing;

update public.app_meta set value = '34' where key = 'schema_version';
