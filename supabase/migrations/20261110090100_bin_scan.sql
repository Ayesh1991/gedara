-- Phase 11 · 106 — what the bin scanner read
-- bin_scan: one row per thing the scanner sent: a scanned code in a mode (use / add / open / waste /
-- check), or a press of its Undo key. It is the scanner's history, its "Needs you" inbox and the
-- idempotency record: a row is unique by (device, epoch, seq), so a resend returns the stored
-- `result` and moves nothing. Stock itself changes only through stock_movement rows (rule 1);
-- `correlation_id` links them. The scanned text is untrusted: at most 96 printable ASCII characters,
-- stored and shown as plain text.
-- Clients only read this table (Realtime for the pop-ups); every write goes through the RPCs of
-- migration 108.

create table public.bin_scan (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.household (id) on delete cascade,
  device_id      uuid,
  epoch          bigint not null check (epoch between 0 and 4294967295),
  seq            bigint not null check (seq between 0 and 4294967295),
  at             timestamptz not null,                    -- when it was scanned
  received_at    timestamptz not null default now(),
  time_estimated boolean not null default false,
  kind           text not null default 'scan' check (kind in ('scan', 'undo')),
  mode           text check (mode in ('use', 'add', 'open', 'waste', 'check')),
  count          integer not null default 1 check (count between 1 and 20),
  code           text check (code ~ '^[ -~]{1,96}$'),
  code_kind      text check (code_kind in ('barcode', 'product', 'lot', 'tag', 'place', 'thing', 'other')),
  product_id     uuid,
  lot_id         uuid,
  -- Final: used · wasted · opened · added · moved (pack moved into its scale jar) · in_jar (already
  -- there) · no_stock · nothing_to_open · checked · not_pantry · undo · undo_none · dismissed · error.
  -- Waiting for a person: unknown (barcode not linked yet) · bill_guard (a bill just added it) ·
  -- held (the scanner was paused).
  status         text not null check (status in (
                   'used', 'wasted', 'opened', 'added', 'moved', 'in_jar', 'no_stock', 'nothing_to_open', 'checked',
                   'not_pantry', 'undo', 'undo_none', 'dismissed', 'error', 'unknown', 'bill_guard', 'held')),
  qty            numeric(14,4),                           -- what moved, in the product's stock unit (− out, + in)
  left_qty       numeric(14,4),                           -- the product's stock afterwards
  correlation_id uuid,
  list_item_id   uuid,                                    -- the shopping-list line this scan added
  target_id      uuid,                                    -- an undo: the scan it undid
  bill_line_id   uuid,                                    -- an Add that a later bill accounted for
  undone_at      timestamptz,
  undone_by      uuid references auth.users (id) on delete set null,   -- null = the scanner's own key
  resolved_at    timestamptz,
  resolved_by    uuid references auth.users (id) on delete set null,
  error_code     text check (length(error_code) <= 10),
  result         jsonb not null check (jsonb_typeof(result) = 'object'),
  unique (household_id, id),
  unique (device_id, epoch, seq),
  check ((kind = 'scan') = (mode is not null and code is not null)),
  foreign key (household_id, device_id) references public.device (household_id, id)
    on delete set null (device_id),
  foreign key (household_id, product_id) references public.product (household_id, id)
    on delete set null (product_id),
  foreign key (household_id, lot_id) references public.stock_lot (household_id, id)
    on delete set null (lot_id),
  foreign key (household_id, bill_line_id) references public.transaction_line (household_id, id)
    on delete set null (bill_line_id)
);

create index bin_scan_household_idx on public.bin_scan (household_id, received_at desc);
create index bin_scan_device_idx on public.bin_scan (device_id, received_at desc);
create index bin_scan_waiting_idx on public.bin_scan (household_id, status)
  where status in ('unknown', 'bill_guard', 'held');
create index bin_scan_product_idx on public.bin_scan (household_id, product_id) where product_id is not null;
create index bin_scan_lot_idx on public.bin_scan (household_id, lot_id) where lot_id is not null;
create index bin_scan_line_idx on public.bin_scan (household_id, bill_line_id) where bill_line_id is not null;
create index bin_scan_correlation_idx on public.bin_scan (household_id, correlation_id) where correlation_id is not null;
create index bin_scan_undone_by_idx on public.bin_scan (undone_by) where undone_by is not null;
create index bin_scan_resolved_by_idx on public.bin_scan (resolved_by) where resolved_by is not null;

alter table public.bin_scan enable row level security;
revoke all on table public.bin_scan from anon, authenticated;
grant select on table public.bin_scan to authenticated;

create policy bin_scan_select on public.bin_scan
  for select to authenticated
  using (private.is_member(household_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.bin_scan;
  end if;
end;
$$;

-- "Finished at the bin" lines on the shopping list.
alter table public.shopping_list_item drop constraint shopping_list_item_source_check;
alter table public.shopping_list_item add constraint shopping_list_item_source_check
  check (source in ('manual', 'below_min', 'forecast', 'recipe', 'scanner'));

update public.app_meta set value = '106' where key = 'schema_version';
