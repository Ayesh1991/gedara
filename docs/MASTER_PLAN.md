# Gedara (ගෙදර) — Master Plan v1.1 (final for handoff)

**Source of truth.** Where this file and `docs/archive/SYSTEM_ARCHITECTURE.md` disagree (schema
especially), **this file wins**. `HANDOVER.md` remains valid for history, lessons, scanning design
and the bill-scanner workflow. This document is the single
brief to hand to Claude Code. Read §0 first.

> Project name: **Gedara** (ගෙදර — "home"). Final. Use `gedara` for the repo, packages, Supabase
> projects and the Vercel project. The app header shows "Gedara" with "ගෙදර" as a subtitle.

---

## 0. What changed after reviewing all four sources

| Source reviewed | What it contributes | What was missing from the old spec |
|---|---|---|
| **Home Ledger v7** (`ledger/index.html`) | Live expense tracking, 9 tuned categories + subs, deterministic djb2 fingerprint, drill-down insights (category → sub → product → price trend), dark navy/gold design, version badge + Test connection | **Income** was never modelled (expenses only). No accounts (cash / bank / card), no budgets, no recurring bills |
| **Grocy** (your live Home Assistant add-on + source) | Stock overview, purchase/consume/open/transfer/inventory, stock journal with undo, stock entries (batches), barcodes per product, quantity-unit conversions, due-date types, shopping list, product groups, parent products, price history, Grocycode | Old spec had **no batches (lots)**, **no unit conversions**, **no "opened" state**, **no shopping list** — all of which your screenshots show you rely on |
| **Your Grocy screenshots** | Real usage: 46 products, loose spices in grams, eggs in packs, Sinhala/Tamil labels, photos taken on the table | Shows the pain points to design out (see §0.1) |
| **Homebox** (`backend/internal/data/ent/schema`) | Assets: serial/model/manufacturer, warranty (incl. lifetime), purchase + sold details, insured flag, labels (tags), custom fields, parent/child items, maintenance log with cost, attachments typed as photo/manual/warranty/receipt, asset IDs, group (household) ownership | Old spec **did not cover non-consumables at all** — one `item` table cannot serve both a 5 g spice pack and a laptop with a serial number and warranty |

### 0.1 Pain points visible in your Grocy screenshots (design these out)

1. **"$6,160,510.30 total value"** for 46 kitchen products — prices entered per *pack* but stored
   per *gram* (or vice-versa). Root cause: unit conversions are optional and invisible.
   → In Gedara every price is normalised to a **base unit** at write time and shown as
   "Rs 1,240 / kg" so a nonsense number is obvious immediately.
2. **Currency shows `$`** → hard-code LKR (`Rs`, `en-LK`, 2 dp) with a household setting.
3. **17 expired + 18 overdue** — most are loose spices whose "due date" is really a *best-before*
   that nobody re-checks. → Separate *expiry* (unsafe, red) from *best-before* (quality, amber),
   and add **"still fine — extend 30 days"** as a one-tap action.
4. **"Price history: No price history available"** — Grocy never learned prices because bills
   lived in the ledger. → Bill import *is* the purchase, so every line becomes a price point.
5. **Edit-product form has ~35 fields on one page** → progressive disclosure: 5 fields on create,
   everything else in collapsible "Advanced" sections with smart defaults per category.
6. Grocy lives **inside Home Assistant ingress** — only reachable at home. → Supabase + Vercel is
   reachable anywhere (shop aisle, pharmacy, office).

---

## 1. The product in one picture

```
                         ┌──────────────── SCAN ANYWHERE (camera · USB wedge · QR) ───────────────┐
                         ▼                                                                           │
 ┌───────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
 │  MONEY    │   │   PANTRY     │   │   THINGS     │   │   PLACES     │   │   INSIGHTS          │  │
 │ (Ledger)  │◄─►│ (Grocy-like) │   │ (Homebox-    │◄─►│ (QR location │   │  drill-down         │  │
 │ income,   │   │ consumables, │   │  like)       │   │  tree: room ›│   │  anywhere, forecasts│  │
 │ expenses, │   │ lots, expiry,│   │ assets, serial│  │  cupboard ›  │   │  cost-of-ownership  │  │
 │ accounts, │   │ units, shop- │   │ warranty,    │   │  box › drawer│   │  personal inflation │  │
 │ budgets,  │   │ ping list    │   │ maintenance, │   └──────▲───────┘   └─────────▲───────────┘  │
 │ recurring │   └──────▲───────┘   │ documents    │          │                     │              │
 └────▲──────┘          │           └──────▲───────┘          │                     │              │
      │   one bill line becomes EITHER a stock lot (Pantry) OR an asset (Things) OR just an expense │
      └──────────────────────────── transaction_line ──────────────────────────────────────────────┘
                                   (the spine that links everything)
```

**The one rule that makes it "one system" instead of three apps glued together:**
every rupee lives in `transaction_line`, and every physical thing points back to the line that
bought it. Everything else (price history, cost of ownership, waste in Rs, warranty receipts,
personal inflation) falls out of that link for free.

### 1.1 The three kinds of "thing"

| Kind | Examples | Tracked as | Identity |
|---|---|---|---|
| **Consumable (stock)** | rice, sugar, Nescafé 50 g, detergent, paracetamol, AA batteries (unused), 10 kΩ resistors | `product` + `stock_lot` (quantity, fungible) | EAN barcode or `HL:PRD:` QR |
| **Asset (durable)** | fridge, laptop, drill, iron, gas cooker, glucometer, books, furniture | `asset` (one row per physical object; qty allowed for identical sets like 6 chairs) | `HL:AST:` QR / asset tag `A-0042` |
| **Expense only** | electricity, fuel, dining, insurance premium, salary (income) | `transaction_line` only | — |

A bill line decides its own destiny at import time (category default + user override):
`grocery / consumables → stock_lot`, `non-consumables / electronics / appliances → asset`,
`energy / services / dining / transport → expense only`. Electronics *components* (resistors,
ICs) are consumables — they are counted, not serialised.

---

## 2. Tech stack (confirmed + additions)

| Layer | Choice | Note |
|---|---|---|
| Frontend | Vite + React 18 + TypeScript + Tailwind + shadcn/ui | as before |
| Routing | TanStack Router (file-based, typed search params) | deep links for every drill-down: `/insights/spend?cat=grocery&sub=Rice&from=2026-01` |
| Data | TanStack Query + supabase-js v2 + generated DB types (`supabase gen types`) | |
| Motion | Framer Motion | page transitions, count-up numbers, shared-element photo zoom |
| Charts | Recharts for standard charts, keep the ledger's hand-rolled SVG for sparklines/donut | |
| Search | Postgres `pg_trgm` + `unaccent` + a single `search_index` view | powers the ⌘K palette |
| Scanning | `barcode-detector` polyfill + `zxing-wasm`; keyboard-wedge listener (spec §5b) | |
| Labels | `qrcode`, `bwip-js`, `pdf-lib` | |
| Images | client-side resize → WebP (1600 px main + 320 px thumb) with `browser-image-compression` before upload | Supabase *on-the-fly* image transforms are a **paid-plan** feature — do not rely on them on Free |
| Offline | `vite-plugin-pwa` (Workbox) **NetworkFirst** for HTML/JS, StaleWhileRevalidate for images, IndexedDB outbox for scans made offline | lesson from ledger v1–v7 |
| Backend | Supabase: Postgres, Auth (**email 6-digit OTP code**, not magic link — see §11; passkey later), Storage, Realtime, Edge Functions, `pg_cron` | |
| Hosting | **Vercel** (recommended) — preview URL per branch, instant rollback | |
| Tests | Vitest (units, fingerprint, unit conversion), Playwright (scan → consume flow), pgTAP or plain SQL tests for triggers & RLS | |

Free-tier reality check (verify on supabase.com/pricing before launch): ~500 MB database,
~1 GB file storage, and projects pause after about a week with no activity. With WebP compression
(~150 KB/photo) 1 GB ≈ 6,000 photos. Daily use keeps the project awake; add a `pg_cron`-independent
keep-alive (Vercel cron hitting `/api/ping`) as insurance.

---

## 3. Data model (Postgres) — replaces §4 of SYSTEM_ARCHITECTURE.md

### 3.0 Fixes to the old schema (why it's being replaced)

1. `stock_movement` referenced `purchase` before it was created (ordering error).
2. The stock trigger coalesced a null location to the all-zero UUID, which **violates the FK** to
   `location` — the first "consumed without location" insert would fail.
3. `stock` and `category` had no owner column → RLS could not protect them.
4. "Expiring soon" was computed from `stock_movement.expiry_date`, but consume movements don't say
   which batch they used → impossible to know what is left of each batch. **Lots are required.**
5. No unit conversion (the $6 M bug).
6. `user_id` ownership locks you into single-user. Homebox's **group** model is better:
   everything belongs to a **household**; users are members. Costs nothing now, avoids a
   rewrite later.
7. `purchase_item.fingerprint` must include the line index (the ledger already does
   `billId-idx-hash`) or two identical lines on one bill collide. Uniqueness must be per household.

> The SQL below is a **design sketch** grouped by module for readability (`pk` = `uuid primary key
> default gen_random_uuid()`). Claude Code should split it into migrations in dependency order
> (units → household/category → location → money → product/lots → assets → attachments), add
> `household_id not null` + FK + RLS to every table, and add FK constraints that point "forward"
> with `alter table` in a later migration.

### 3.1 Tenancy & users

```sql
create table household (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'LKR',
  locale text not null default 'en-LK',
  timezone text not null default 'Asia/Colombo',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table household_member (
  household_id uuid references household(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','member','viewer')),
  display_name text,
  primary key (household_id, user_id)
);
create table household_invite (    -- only invited emails can join (public sign-up disabled)
  household_id uuid references household(id) on delete cascade,
  email text not null, role text not null check (role in ('owner','member','viewer')),
  display_name text, accepted_at timestamptz,
  primary key (household_id, email)
);
-- trigger on auth.users insert: if email matches an open invite → insert household_member
-- RLS helper used by every policy
create function is_member(h uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists(select 1 from household_member where household_id = h and user_id = auth.uid())
$$;
-- Pattern for every table:  using (is_member(household_id)) with check (is_member(household_id))
-- viewer role: separate policy denying insert/update/delete.
```

### 3.2 Shared master data

```sql
create table category (            -- one taxonomy for money + pantry + things
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  parent_id uuid references category(id),
  name text not null, icon text, color text,
  kind text not null check (kind in ('expense','income','both')),
  default_destiny text not null default 'expense'
      check (default_destiny in ('stock','asset','expense')),   -- drives bill import
  sort int default 0, archived boolean default false
);
create table tag (id uuid pk, household_id uuid, name text, color text);        -- Homebox "labels"
create table merchant (id uuid pk, household_id uuid, name text, aliases text[],  -- "Cargills Food City", "Keells", "LAUGFS"
                       kind text, location_text text);
create table unit (                -- g, kg, ml, L, pcs, pack, bottle, kWh, m³ ...
  id uuid pk, household_id uuid null,          -- null = system unit
  code text not null, name text, dimension text check (dimension in ('mass','volume','count','energy','length','other')),
  to_base numeric                              -- g=1, kg=1000 (base: g / ml / pcs)
);
create table product_unit_conversion (          -- Grocy "product specific QU conversions": 1 pack = 400 g
  product_id uuid references product(id) on delete cascade,
  from_unit uuid references unit(id), to_unit uuid references unit(id), factor numeric not null,
  primary key (product_id, from_unit, to_unit)
);
```

### 3.3 Places (location tree + QR)

```sql
create table location (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  parent_id uuid references location(id),
  name text not null,
  kind text check (kind in ('room','furniture','container','drawer','shelf','zone','vehicle','offsite')),
  code text unique not null,         -- 'HL:LOC:7K2P9Q' (6-char Crockford base32, UPPERCASE only — keeps the QR in alphanumeric mode, see §7c)
  climate text check (climate in ('ambient','fridge','freezer','dry','humid')),  -- drives due-date rules
  photo_path text, notes text,
  map_x numeric, map_y numeric,      -- optional pin on a floor-plan image (Phase 6)
  path text                          -- materialised "Kitchen › Pantry cupboard › Box 3", maintained by trigger
);
```

### 3.4 Pantry (consumables — Grocy replacement)

```sql
create table product (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  name text not null, name_si text,                 -- Sinhala/Tamil alias for search
  parent_id uuid references product(id),            -- Grocy parent product: "Rice" > "Keeri samba", "Rathu kekulu"
  category_id uuid references category(id),
  product_group text,
  stock_unit uuid references unit(id) not null,     -- what you count in (g for loose spices)
  purchase_unit uuid references unit(id),           -- what you buy in (pack)
  min_qty numeric, reorder_qty numeric,
  default_location_id uuid references location(id),
  due_type text check (due_type in ('none','best_before','expiry')) default 'none',
  default_due_days int, due_days_after_open int, due_days_frozen int,
  quick_consume_qty numeric default 1,
  treat_opened_as_out boolean default false,
  code text unique,                                 -- 'HL:PRD:...' for loose/unbarcoded
  attributes jsonb not null default '{}',           -- resistor: {value:'10k', package:'0805', tolerance:'1%'}
  photo_path text, notes text, archived boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table product_barcode (                      -- many EANs per product, each with pack size
  id uuid pk, product_id uuid references product(id) on delete cascade,
  barcode text not null, unit_id uuid references unit(id), qty numeric default 1,  -- 4792024000222 = 1 pack = 50 g
  merchant_id uuid references merchant(id), unique (barcode, product_id)
);

create table stock_lot (                            -- a batch: "the 1 kg sugar bought 2026-09-20 at Keells"
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  product_id uuid not null references product(id),
  location_id uuid references location(id),
  qty_initial numeric not null, qty_remaining numeric not null,   -- in product.stock_unit
  unit_cost numeric,                                -- Rs per stock_unit (normalised!)
  purchased_on date, due_date date, opened_at timestamptz,
  transaction_line_id uuid references transaction_line(id),
  status text generated always as (case when qty_remaining <= 0 then 'empty' else 'active' end) stored
);

create table stock_movement (                       -- append-only journal (never update/delete)
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  lot_id uuid not null references stock_lot(id),
  product_id uuid not null references product(id),
  delta numeric not null,                           -- in stock_unit
  reason text not null check (reason in
    ('purchase','consume','open','waste','adjust','transfer_out','transfer_in','undo')),
  location_id uuid references location(id),
  unit_cost numeric,
  correlation_id uuid,                              -- groups a multi-lot consume / a transfer pair
  reverses_id uuid references stock_movement(id),   -- for undo (Grocy journal "undo" button)
  recipe_or_note text, actor uuid references auth.users(id),
  created_at timestamptz default now()
);
-- Trigger: on insert → update stock_lot.qty_remaining (and location for transfers).
-- All writes go through SECURITY DEFINER RPCs, never direct inserts from the client:
--   rpc_purchase(product, qty, unit, location, cost, due, line_id)
--   rpc_consume(product, qty, unit, location?, mode 'fefo'|'fifo'|lot_id, reason 'consume'|'waste')
--       → splits across lots (earliest due first), returns correlation_id
--   rpc_open(lot or product), rpc_transfer(lot, to_location, qty), rpc_inventory(product, location, counted_qty)
--   rpc_undo(correlation_id)
-- RPCs convert units via product_unit_conversion + unit.to_base, and lock lots (select ... for update)
-- so two devices consuming at once can't go negative.

create view v_stock as           -- replaces the old `stock` table
  select household_id, product_id, location_id,
         sum(qty_remaining) qty, min(due_date) next_due,
         sum(qty_remaining * coalesce(unit_cost,0)) value,
         bool_or(opened_at is not null) any_opened
  from stock_lot where qty_remaining > 0 group by 1,2,3;

create table shopping_list_item (
  id uuid pk, household_id uuid, list text default 'Main',
  product_id uuid references product(id), free_text text,
  qty numeric, unit_id uuid references unit(id),
  source text check (source in ('manual','below_min','forecast','recipe')),
  done boolean default false, done_by_line uuid references transaction_line(id)
);
```

### 3.5 Things (durables — Homebox replacement)

```sql
create table asset (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  asset_no int not null,                            -- human tag A-0042 (sequence per household)
  code text unique not null,                        -- 'HL:AST:...'
  name text not null, description text,
  category_id uuid references category(id),
  location_id uuid references location(id),
  parent_asset_id uuid references asset(id),        -- laptop › charger, car › spare wheel
  quantity int not null default 1,
  manufacturer text, model_no text, serial_no text,
  condition text check (condition in ('new','good','fair','poor','broken')),
  status text not null default 'in_use' check (status in
     ('in_use','stored','lent','in_repair','sold','disposed','lost')),
  lent_to text, lent_on date,
  -- money links
  transaction_line_id uuid references transaction_line(id),  -- the bill that bought it
  purchase_price numeric, purchased_on date, vendor text,
  useful_life_months int, salvage_value numeric,              -- straight-line depreciation
  warranty_until date, lifetime_warranty boolean default false, warranty_notes text,
  insured boolean default false, insurance_policy_asset_id uuid references asset(id),
  sold_on date, sold_to text, sold_price numeric, sale_transaction_id uuid references money_transaction(id),
  custom jsonb not null default '{}',               -- Homebox custom fields, schema from category_field
  archived boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table category_field (                       -- field templates: "Electronics" → {IMEI, RAM, storage}
  id uuid pk, category_id uuid references category(id), key text, label text,
  type text check (type in ('text','number','boolean','date','select','url')), options text[]
);
create table asset_tag (asset_id uuid, tag_id uuid, primary key (asset_id, tag_id));

create table maintenance_plan (                     -- recurring: AC service every 6 mo, change UPS battery every 2 y,
  id uuid pk, household_id uuid, asset_id uuid references asset(id) on delete cascade,  -- also replaces Grocy "batteries"
  name text, every_days int, every_usage numeric, usage_unit text,  -- e.g. every 5000 km
  next_due date, notify_days_before int default 7
);
create table maintenance_log (
  id uuid pk, household_id uuid, asset_id uuid references asset(id) on delete cascade,
  plan_id uuid references maintenance_plan(id),
  done_on date, title text, notes text, cost numeric,
  vendor text, transaction_id uuid references money_transaction(id),   -- cost flows to ledger
  usage_reading numeric
);
```

### 3.6 Money (Ledger v8)

```sql
create table account (                              -- Cash, BOC savings, Sampath credit card, eZ Cash
  id uuid pk, household_id uuid, name text, kind text check (kind in
    ('cash','bank','credit_card','wallet','loan','investment')),
  opening_balance numeric default 0, currency text default 'LKR', archived boolean default false
);
create table money_transaction (                    -- the bill / payslip / transfer header
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  type text not null check (type in ('expense','income','transfer','refund')),
  account_id uuid references account(id), to_account_id uuid references account(id),
  merchant_id uuid references merchant(id), payee_text text,
  occurred_on date not null, occurred_at time,
  invoice_no text, subtotal numeric, discount numeric default 0, total numeric not null,
  source text check (source in ('manual','scan','recurring','import_sheet','import_grocy')),
  fingerprint text not null,                        -- djb2 of invoice|date|time|shop|total (same as ledger v7!)
  recurring_id uuid references recurring_rule(id),
  receipt_path text, notes text, created_by uuid, created_at timestamptz default now(),
  unique (household_id, fingerprint)
);
create table transaction_line (                     -- THE SPINE
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  transaction_id uuid not null references money_transaction(id) on delete cascade,
  line_no int not null,
  raw_name text not null,                           -- exactly as scanned
  category_id uuid references category(id),
  qty numeric, unit_id uuid references unit(id), unit_price numeric, amount numeric not null,
  base_qty numeric, price_per_base numeric,         -- normalised: Rs per kg / L / pcs → price intelligence
  destiny text check (destiny in ('stock','asset','expense')),
  product_id uuid references product(id), asset_id uuid references asset(id),
  fingerprint text not null,                        -- billFp-lineNo-hash(name|amount)  (ledger v7 format)
  unique (household_id, fingerprint)
);
create table recurring_rule (                       -- CEB electricity, NWSDB water, SLT/Dialog, insurance, salary
  id uuid pk, household_id uuid, name text, type text, account_id uuid, category_id uuid,
  expected_amount numeric, rrule text, next_due date, autopost boolean default false,
  usage_unit text                                   -- 'kWh', 'm³' → track units, not just Rs
);
create table budget (id uuid pk, household_id uuid, category_id uuid, month date, amount numeric);
create table meter_reading (id uuid pk, household_id uuid, recurring_id uuid, read_on date, value numeric);  -- kWh / m³ trend
```

### 3.7 Cross-cutting

```sql
create table attachment (                           -- one table for every file in the system
  id uuid pk, household_id uuid,
  entity_type text check (entity_type in ('product','lot','asset','location','transaction','maintenance')),
  entity_id uuid not null,
  kind text check (kind in ('photo','receipt','warranty','manual','invoice','label','other')),
  storage_path text not null, thumb_path text, mime text, bytes int,
  is_primary boolean default false, ocr_json jsonb, created_at timestamptz default now()
);
-- Storage bucket 'household-files', path: {household_id}/{entity_type}/{entity_id}/{uuid}.webp
-- Storage RLS: first path segment must satisfy is_member().

create table activity (                             -- unified timeline, written by triggers
  id bigint generated always as identity primary key,
  household_id uuid, at timestamptz default now(), actor uuid,
  entity_type text, entity_id uuid, verb text, summary text, payload jsonb
);
create view search_index as                         -- ⌘K palette: one query, every entity
  select 'product' t, id, household_id, name || coalesce(' '||name_si,'') txt from product
  union all select 'asset', id, household_id, concat_ws(' ', name, manufacturer, model_no, serial_no, 'A-'||asset_no) from asset
  union all select 'location', id, household_id, path from location
  union all select 'transaction', id, household_id, concat_ws(' ', payee_text, invoice_no) from money_transaction;
-- + gin trigram indexes on the underlying columns
create table app_meta (key text primary key, value text);   -- schema_version for the diagnostics panel
```

### 3.8 QR / code scheme (extends spec §5c)

| Prefix | Entity | Example |
|---|---|---|
| `HL:LOC:` | location | `HL:LOC:7K2P9Q` |
| `HL:PRD:` | product without an EAN (loose rice, resistors) | `HL:PRD:3MX81A` |
| `HL:AST:` | asset | `HL:AST:A0042` |
| `HL:LOT:` | a specific batch (optional, for freezer bags / jars you refill) | `HL:LOT:9QW2` |
| raw digits | EAN/UPC → `product_barcode` | `4792024000222` |
| `grcy:p:…` | legacy Grocycodes already printed | map during Grocy import so old labels keep working |

Small labels carry the raw code only; A4 box/room/asset labels carry
`https://gedara.vercel.app/s/HL:LOC:7K2P9Q` so the phone's normal camera deep-links into the
right page (see §7d). The resolver accepts both forms and strips the URL prefix.

---

## 4. How the modules interconnect (the "extraordinary" part)

| # | Trigger | What happens automatically |
|---|---|---|
| 1 | Import a scanned bill | 1 `money_transaction` + N lines. Each line is matched (barcode → alias → trigram name) to a product/asset. Stock lines create lots with normalised unit cost and due date; asset lines create draft assets (fill serial/warranty later); shopping-list items for those products are ticked off. |
| 2 | Scan a location QR | Shows **everything** there: pantry lots with due dates, assets with photos, sub-locations. Actions: consume, move here, count (inventory), print label. |
| 3 | Consume / waste | Lot decreases FEFO; consumption cost (Rs) is recorded, so "we ate Rs 18,400 of groceries this month" is separate from "we spent Rs 26,000". Waste shows Rs lost. |
| 4 | Stock ≤ min, or forecast says empty in < 5 days | Added to shopping list with suggested qty and **cheapest recent merchant** (from `price_per_base`). |
| 5 | Asset gets a maintenance log with cost | A ledger expense is created (category Services › Repairs) and linked; the asset's cost-of-ownership updates. |
| 6 | Asset marked sold | Income transaction created, depreciation closed, profit/loss shown. |
| 7 | Warranty ≤ 30 days / insurance renewal / recurring bill due / lot expiring | Unified **Attention** feed + optional Web Push (Edge Function via `pg_cron` daily 07:00 Colombo). |
| 8 | Receipt photo on a transaction | Also attached as `kind='warranty'` to any asset bought on that bill — "where's the TV receipt?" is solved forever. |
| 9 | Electricity bill scanned with kWh | Meter reading stored; Insights shows Rs/kWh tier creep and usage trend. |
| 10 | Any number anywhere | Is a link. Clicking drills one level deeper, down to the individual bill line or stock movement. |

---

## 5. Screens & UX

### 5.1 Navigation (mobile bottom bar · desktop left rail)

`Home` · `Money` · **`Scan` (centre, gold)** · `Pantry` · `Things` — with `Places` and
`Insights` reachable from Home and the ⌘K palette. (Five tabs keep one-thumb reach on the iPad /
phone.)

### 5.2 Key screens

- **Home / "Pulse"** — this month's cash flow (in − out), budget burn ring, *Attention* cards
  (3 expiring, 2 below min, CEB due in 4 days, warranty on washing machine ends in 21 days),
  recent activity timeline, quick tiles (the ledger's QUICK grid carried over: Fuel, Electricity,
  LP Gas, Water, Insurance, Telecom, Dining, Grocery).
- **Scan HUD** — full-screen camera with a translucent result card that slides up; stays open for
  rapid-fire scanning ("scan 12 items into Box 3"). USB wedge works from any screen and shows the
  same card as a toast.
- **Money** — transactions list grouped by bill (ledger style), accounts & balances, budgets,
  recurring, import (paste JSON / drop file / Drive pull / in-app AI scan).
- **Pantry** — Grocy stock overview reimagined: cards or dense table toggle; status chips
  (expired / best-before passed / due soon / below min / opened); swipe right = consume 1, swipe
  left = consume all, long-press = open/transfer/waste; per-product page with lots, price per kg
  by merchant, consumption velocity, days-to-empty.
- **Things** — gallery/grid of assets with photo, asset tag, location breadcrumb, warranty badge;
  asset page with timeline (bought → moved → serviced → lent), documents tab, cost-of-ownership.
- **Places** — drill-in explorer: room tiles with photos → furniture → boxes; each level shows
  counts and value; bulk "print labels for all boxes in Store room"; optional floor-plan with
  pinned rooms (Phase 6).
- **Insights** — see §6.
- **Settings / Diagnostics** — version badge (app build + git SHA + DB `schema_version`),
  **Test connection** (Auth ✓ · DB ✓ · Storage ✓ · Realtime ✓ · Edge fn ✓ · SW version), clear
  cache & reload, export everything (JSON + CSV + photos zip).

### 5.3 Visual language ("futuristic but calm")

Carry over the ledger tokens exactly (`--ink #0B101C`, `--panel #141C30`, `--gold #F2B33D`,
`--teal #2FC6A0`, `--red #FF6B6B`, Space Grotesk + IBM Plex Mono for numbers) and add:
glass panels (backdrop-blur 12 px, 1 px `--line-2` border), gold glow only on the *one* primary
action per screen, numbers count up on load, mono tabular figures for all Rs amounts, shared-element
photo zoom from grid → detail, subtle scan-line animation in the Scan HUD, light theme as an option
(the ledger's `--paper` tokens). Respect `prefers-reduced-motion`.

### 5.4 Friendliness rules

- Create forms ask **≤ 5 fields**; the rest is "Advanced" with category-driven defaults
  (Grocery › Spices → unit g, best-before, 180 days, Kitchen).
- Every destructive or stock action shows an **Undo** toast for 8 s (backed by `rpc_undo`).
- Sinhala/Tamil product names searchable (`name_si`); UI strings in `i18n` files from day one
  (English first; Sinhala later is then a translation job, not a refactor).
- Keyboard-first on desktop: `⌘K` palette, `/` search, `N` new, `S` scan, `G then P` go to Pantry.

---

## 6. Analytics — "dig in-depth" design

Every chart follows the same **4-level drill contract**, carried over from ledger v7:
`Domain → Category → Sub-category / Product → Individual record`, with the path in the URL so
any view is bookmarkable and shareable between devices.

| Area | Views (all as Postgres views/RPCs, charted client-side) |
|---|---|
| **Cash flow** | income vs expense by month, savings rate, account balances over time, budget vs actual, recurring vs discretionary split |
| **Spend** | category donut → sub → product → bill lines (existing); by merchant; by payment method; weekday/time-of-day heatmap |
| **Price intelligence** | Rs per base unit over time per product; per merchant comparison ("Keeri samba is 6 % cheaper at Keells"); **personal inflation index** — your own basket, 12-month change, next to published CCPI for reference |
| **Pantry** | consumption velocity, days-to-empty forecast, waste Rs by category/month, spoil rate per product, "consumed Rs vs bought Rs" (stockpiling indicator), stock value by location |
| **Things** | total asset value (cost vs depreciated), insured vs uninsured value (useful for home insurance), cost-of-ownership per asset (price + maintenance − resale) ÷ months owned, warranty calendar, maintenance calendar |
| **Utilities** | kWh and m³ trends from meter readings, Rs/kWh effective tariff, LP gas cylinder interval |
| **Places** | utilisation per container, "what's in the store room" value, stale items (not touched in 12 months → declutter list) |

Heavy aggregates: nightly `pg_cron` refresh of `mv_monthly_spend`, `mv_product_velocity`; live
data for everything else.

---

## 7. AI & automation (optional layers, in order of value)

1. **Keep the Claude "Bill Scanner" project** exactly as today (zero cost). Import = paste / drop
   JSON. Validate with a Zod schema; reject Google-Doc-wrapped JSON gracefully (lesson §4 of handover).
2. **In-app scan (Phase 7, optional):** Edge Function `scan-document` → Claude API vision with the
   same system prompt as the Bill Scanner project → returns the same JSON. Works for bills,
   product labels (expiry, manufacturer), warranty cards, appliance rating plates (model/serial →
   pre-fills an asset). API key stays server-side; cost is roughly cents per scan — set a monthly
   cap in the function.
3. **Open Food Facts lookup** for unknown EANs (spec §5e) — coverage for Sri Lankan brands is
   patchy, so the "learn once" loop matters more: first scan asks, every later scan knows.
4. **"Ask Gedara"** (later): natural-language questions answered by calling a fixed set of
   read-only RPCs as tools ("how much did we spend on fish since June?", "where is the drill?") —
   never free-form SQL.

---

## 7b. Kitchen Scale Station (Raspberry Pi 2 + 5 kg load cell + HX711 + USB scanner)

**Purpose:** exact consumption of loose goods (sugar, flour, salt, rice, spices, tea, milk
powder) with no typing. Weighing replaces guessing "how much did I use?"

### Core idea: weigh the jar, not the scoop
Each loose-goods jar gets a QR label (`HL:LOC:` — the jar is a location of kind `container`) and a
stored **tare weight**. One jar holds one product.

```
scan jar QR ─► put jar on scale ─► stable reading ─► net = gross − tare
            ─► rpc_weigh(jar, net_g)  →  compares with stock in that jar
                  net < stock  → consume movement (−difference)      [automatic]
                  net > stock  → refill: transfer from pantry pack / purchase  [confirm on iPad/phone]
                  |diff| < 2 g → no change (noise)
```
Result: every lift of the jar becomes an exact consumption record, and each weighing is also a
free stock count, so errors can't build up.

### Architecture
```
Pi 2 (Python service "gedara-scale", systemd)
 ├─ HX711 reader: 10 Hz, median-of-7 filter, stability = 1.5 s within ±1 g, auto-zero when empty
 ├─ USB scanner via evdev with exclusive grab (codes don't leak to the Pi's console)
 ├─ SQLite outbox (keeps working when Wi-Fi/Supabase is down, syncs later)
 └─ HTTPS ─► Supabase Edge Function `device-ingest`  (per-device secret, NOT a user login)
                 ├─ validates device token (hash in `device` table), rate-limits
                 ├─ calls rpc_weigh / rpc_consume / rpc_purchase as that household
                 └─ Realtime broadcast `scale:{device_id}` ─► iPad/phone shows live weight + result card
```
- The Pi has **no screen requirement**: feedback comes from a buzzer/LED on the Pi (beep = logged,
  double-beep = needs confirmation) and the live card on whatever device is open to the app.
- **Scan a product barcode instead of a jar** → "weigh-out" mode: tare with the pack on, remove
  what you need, the difference is consumed from that product's oldest lot.
- **Calibration page** in the web app (Settings › Devices): put a known weight (e.g. 1 kg sugar
  pack), save the factor; drift check weekly.

### Schema additions
```sql
alter table location add column tare_g numeric, add column holds_product_id uuid references product(id);
create table device (
  id uuid pk, household_id uuid, name text, kind text default 'scale',
  token_hash text not null, calibration jsonb, last_seen timestamptz, sw_version text
);
create table scale_reading (                  -- raw audit trail, pruned after 90 days
  id bigint generated always as identity primary key, household_id uuid,
  device_id uuid references device(id), at timestamptz default now(),
  gross_g numeric, net_g numeric, stable boolean,
  location_id uuid, product_id uuid, movement_correlation uuid
);
-- rpc_weigh(location_id, net_g, device_id) → returns {action, delta, new_qty, needs_confirmation}
```

### Hardware notes
- **Pi 2 has no built-in Wi-Fi** → Ethernet or a USB Wi-Fi dongle. It is powerful enough for this
  (Python, no browser on the Pi).
- **HX711 on Linux** is timed bit-by-bit in software, so the occasional reading is garbage — the
  median filter handles this. If readings stay noisy, move the HX711 to an **ESP32** (ESPHome,
  already in your Home Assistant) and let the Pi only handle the scanner and uploads.
- 5 kg capacity includes the jar: glass jars weigh 300–600 g, so keep bulk rice (5 kg+) in the
  pantry and refill a smaller jar.
- Load cells creep and change with temperature: auto-zero when the platform is empty, and only
  accept readings when the platform has been still for 1.5 s.

### Diagnostics (lesson from the ledger)
Settings › Devices shows: last seen, software version, last 20 readings, current raw/net weight
live, outbox queue length, and a **"Test beep + ping"** button.

---

## 7c. Printing & labels (decided)

| Printer | Use for | How it's driven |
|---|---|---|
| **Epson L3110** (owned) | Bulk sheets: **54 QR labels per A4 (6 rows × 9 columns)**, printed on A4 sticker paper for boxes, shelves, rooms, drawers | Browser prints a `pdf-lib` PDF. The grid template is configurable (rows, columns, margins, cell size) with a **calibration test page**, because inkjet feed offsets vary |
| **NIIMBOT B1** (recommended purchase) | One-off die-cut adhesive labels made on the spot: new jar, new asset, a freezer bag with a date | **Pi print service** using the open-source `niimprint` Python library (B1 via USB or Bluetooth). The web app sends a print job → Edge Function → Realtime → Pi prints. Fallback: download a PNG and print it from the NIIMBOT phone app |
| EM5822 58 mm receipt printer (not recommended as the label printer) | Only if you want printed shopping lists or a weekly "use these first" slip | ESC/POS over serial from the Pi/ESP32 — simple, but prints on a continuous roll with no die-cut labels and no gap sensing |

Label templates (all generated server-side-independent in the browser, rendered to 203 dpi 1-bit
bitmaps for the thermal printer):
**Decided label stock: NIIMBOT B1 with 20 × 20 mm labels.** 20 mm at 203 dpi ≈ 160 × 160 dots,
so these labels hold a QR plus one short text line, nothing else. Details such as tare weight,
expiry and warranty live in the app and appear when the label is scanned.

- **QR encoding rule (critical at 20 mm):** the QR holds only the raw code, e.g. `HL:LOC:7K2P9Q`
  (13 characters). Upper-case letters, digits and `:` fit QR *alphanumeric mode*, so it fits a
  **version 1 QR (21 × 21 modules), error correction M**. With a 2-module quiet zone the QR is
  about 13 mm wide, ≈ 0.55 mm (~4 dots) per module — sharp enough for phone cameras and the USB
  scanner. Never put a URL on a 20 mm label.
- Render straight to a 1-bit bitmap at the printer's native 203 dpi with whole-dot modules (no
  anti-aliasing and no scaling after rendering), or the QR blurs.

| Template | Layout (20 × 20 mm) | Used for |
|---|---|---|
| `sq20-loc` | QR 13 mm, centred top; 1 line ≤ 10 chars below (e.g. `SUGAR`, `BOX-03`) | jars, drawers, component bins |
| `sq20-ast` | QR 13 mm; asset tag below (`A-0042`) | assets |
| `sq20-lot` | QR 13 mm; expiry below (`EXP 26-10`) | freezer bags, repacked rice/flour |

**Epson A4 sheet (decided): standard A4 sticker paper, 6 rows × 9 columns = 54 labels.**
- Template `a4-6x9`: default **landscape** (297 × 210 mm → cells about 33 × 35 mm). Confirm the
  orientation with the first test print. Rows, columns, orientation, margins and gutters are
  settings, not hard-coded.
- Each cell: a QR of about 24 mm holding the **URL form** (`https://gedara.vercel.app/s/HL:LOC:…`)
  + a name line + a breadcrumb line (e.g. `Store room › Rack 2`).
- A **calibration page** prints cell borders and crosshairs on plain paper. Hold it over a sticker
  sheet against the light, nudge the X/Y offsets (0.5 mm steps) and save them per printer.
- "Print partial sheet" option: start at row r, column c so half-used sticker sheets aren't wasted.

Thermal labels fade with heat and sunlight (roughly 1–2 years). Use NIIMBOT's synthetic/PET label
rolls for kitchen jars and anything near the stove, and paper labels for dry storage.
Print jobs are queued in a `print_job` table (`device_id, template, payload jsonb, status`) so the
Pi picks them up even if it was offline when you pressed Print.

## 7d. Hosting without a custom domain (decided)

- Host on a free `*.vercel.app` subdomain (choose a distinctive project name, e.g.
  `gedara.vercel.app` (fallback `gedara-home.vercel.app` if the name is taken), and never rename that Vercel project).
- **What the QR codes contain:**
  - Small labels (jars, component drawers, lots): **the raw code only** (`HL:LOC:7K2P9Q`). It
    makes a smaller QR that scans better at 12–15 mm, and it never depends on any host. Scan it
    with the in-app scanner, the USB scanner or the Pi.
  - Box/room/asset labels on A4 sheets: `https://gedara.vercel.app/s/HL:LOC:7K2P9Q`, so
    the phone's normal camera opens the right page.
- If you ever change hosts, keep a tiny redirect-only Vercel project at the old subdomain
  (free) so the printed URLs keep working. The raw-code labels are unaffected in any case.
- Everything else (HTTPS, PWA install, Supabase Auth redirects, Web Push) works the same on a
  `vercel.app` subdomain.

## 7e. Photo & file storage tiers (Supabase + Google Drive overflow)

| Tier | What | Where | Why |
|---|---|---|---|
| Hot | Thumbnail (320 px, ~25–40 KB WebP) of **every** photo | Supabase Storage | Lists and grids load instantly; RLS-protected; ~25,000 thumbs per GB |
| Warm | Full-size photos (1600 px WebP, ~150 KB) | Supabase until usage reaches ~70 % of the plan, then new ones go to Drive | Fast direct URLs while space allows |
| Cold | Receipts, warranty cards, manuals (PDF), original camera photos | Google Drive folder `Gedara Files/{household}/{entity_type}/` | Free 15 GB, easy to browse in Drive yourself as a backup |

How Drive is wired (never from the browser directly):
- Edge Function `files-drive` holds a **Google OAuth refresh token for your own account**
  (scope `drive.file`, which only allows access to files the app created) as a Supabase secret.
  Do not use a Google service account: service accounts have no personal Drive quota.
- Upload: browser → Edge Function → Drive; the function returns the `drive_file_id`.
- View: browser → Edge Function (checks household membership) → streams the file. Files stay
  **private** in Drive — never "anyone with the link".
- `attachment` gets `provider text check (provider in ('supabase','gdrive'))` and
  `drive_file_id text`. The UI does not care where a file lives.
- Lesson from the ledger: check the MIME type and size of what Drive returns; never trust the
  file name.
- Settings › Storage shows usage per tier and a "move full-size photos older than 6 months to
  Drive" button.

---

## 8. Migration plan

| From | How | Keep |
|---|---|---|
| Ledger Google Sheet | One-off Node script (`scripts/import-sheet.ts`) reading the Sheet CSV export → `money_transaction` + `transaction_line`, category/sub mapped by name | **existing fingerprints** (dedupe guarantee) |
| Ledger categories & colours | seed SQL from the `CATS` object in ledger `index.html` | exact names, colours, icons, QUICK tiles |
| Grocy (HA add-on) | **Dropped 2026-09-24:** Grocy hadn't been used for 8+ months, so products are entered fresh in Gedara (see `decisions.md`). Original plan: `scripts/import-grocy.ts` via Grocy REST API (`/api/objects/products`, `locations`, `quantity_units`, `quantity_unit_conversions`, `product_barcodes`, `stock`, `stock_log`, `shopping_list`, `/api/files/productpictures/...`) with an API key created in Grocy → products, units, conversions, barcodes, lots (from stock entries), photos to Storage | barcodes, photos, Grocycodes (as aliases), due dates. **Review prices** — they are the $6 M bug; import as null where implausible |
| Homebox | not in use yet → fresh start. (Homebox CSV export format supported later if needed) | — |

Run imports against a **staging** Supabase project first, compare counts/totals, then production.
Keep the ledger v7 PWA running read-only for 1 month as a fallback.

---

## 9. Build plan for Claude Code (revised phases)

Each phase ends with: migrations committed, RLS tests passing, deployed to Vercel preview,
version badge bumped, a short `CHANGELOG.md` entry.

| Phase | Scope | Done when |
|---|---|---|
| **0 Foundation** | Repo, Vite/React/TS/Tailwind/shadcn, design tokens from ledger, PWA NetworkFirst, Supabase project (staging + prod), `supabase/migrations`, household + member + RLS helper, email-OTP auth, app shell with 5 tabs, **Diagnostics page** | You can log in on laptop + iPad, see version + all-green Test connection |
| **1 Places & Scanning** | Location tree CRUD, photo upload pipeline (WebP + thumb), QR generator + bulk label PDF, `/s/:code` deep links, scan HUD (camera + USB wedge), resolver | Print 10 labels, stick on boxes, scan with iPhone camera → opens the box |
| **2 Money core** | Accounts, categories seed, manual expense/income/transfer, bill JSON import with fingerprint dedupe, transaction list, ledger Sheet migration | All historical ledger data in Supabase, totals match the Sheet to the rupee |
| **3 Pantry core** | Units + conversions, products, barcodes, lots, RPCs (purchase/consume/open/transfer/inventory/undo), stock overview, product page, journal | ~~Grocy import done~~ (dropped 2026-09-24, products entered fresh); stock value is sane; FEFO consume works across 2 lots |
| **4 The spine** | Bill import destiny routing (stock/asset/expense), product matching + learning aliases, shopping list (manual + below-min), tick-off on import | Scan a Cargills bill → expense logged, 8 lots created, 3 list items ticked, in one confirm |
| **5 Things** | Assets, tags, category field templates, parent/child, attachments (warranty/manual/receipt), maintenance plans + logs → ledger, lend/sell flows, asset labels | Fridge, TV, laptop entered with receipts & warranty dates; AC service logged as expense |
| **6 Insights & Attention** | Drill-down framework, all §6 views, Attention feed, `pg_cron` jobs, Web Push, ⌘K search, recurring bills + monthly budgets; ~~floor-plan (optional)~~ moved to Phase 7 and personal inflation from our own basket only (no CCPI), 2026-09-25 | Every number clickable to the record level |
| **6b Scale Station** (after Phase 3 or 4) | `device` + `scale_reading`, jar tare, `rpc_weigh`, `device-ingest` Edge Function, Pi Python service + systemd + SQLite outbox, Realtime live card, calibration page | Lift the sugar jar, use 2 spoons, put it back → "Sugar −24 g" appears on the iPad within 2 s |
| **7 AI & polish** | In-app scan Edge Function (optional), Open Food Facts, offline outbox, export/backup, Sinhala strings, performance pass, Places floor-plan (from Phase 6) | Lighthouse PWA ✓, works offline for scan-and-consume |

**Rules for Claude Code on every phase** (put these in the repo's `CLAUDE.md`):
1. Never edit stock or balances directly — only via RPCs / movements.
2. Every table has `household_id` + RLS enabled + a test proving another household can't read it.
3. Money is `numeric(14,2)`; quantities `numeric(14,4)`; format with `Intl.NumberFormat('en-LK',{style:'currency',currency:'LKR'})`.
4. Service worker is NetworkFirst; bump `APP_VERSION` on every deploy; show it in the footer.
5. Validate every external JSON (bill scanner, Open Food Facts) with Zod before use.
6. Migrations are forward-only files; never edit an applied migration.
7. Confirm deploys went live (check the version badge on the live URL) before reporting done.

---

## 10. Decisions to confirm before Phase 0

| Decision | Recommendation | Why |
|---|---|---|
| Hosting | **Vercel** (free Hobby) on a `*.vercel.app` subdomain — **decided: no custom domain** (see §7d) | branch previews, instant rollback, no cache surprises |
| Users | **Household model now, invite family later** | zero extra cost today; no rewrite later |
| Label printers | **Epson L3110** (A4, 6 × 9 = 54 per sheet) + **NIIMBOT B1 with 20 × 20 mm labels** via Pi (see §7c) | **decided** — confirm A4 orientation with the calibration print |
| Photo overflow | Supabase thumbnails + Google Drive for large files (see §7e) | stays within the free tiers |
| Grocy | keep running until Phase 3 import is verified, then retire | safe fallback |
| In-app AI scan | defer to Phase 7 | paste-JSON flow already works and is free |

---

## 11. Handoff to Claude Code — repo layout, accounts, gotchas

### 11.1 Repo layout (monorepo)
```
gedara/
├─ CLAUDE.md                  ← short rules file Claude Code reads every session
├─ docs/
│  ├─ MASTER_PLAN.md          ← this file
│  ├─ HANDOVER.md
│  ├─ archive/SYSTEM_ARCHITECTURE.md   ← superseded schema, kept for history only
│  └─ decisions.md            ← one line per decision made during the build
├─ reference/                 ← read-only inputs (never edited, never shipped)
│  ├─ ledger-v7/index.html    ← design tokens, CATS, QUICK tiles, djb2 fingerprint
│  ├─ bill-scanner/prompt.md + samples/*.json   ← 5–10 real scanned bills
│  ├─ sheet-export/ledger.csv ← for the Phase 2 import test
│  └─ grocy-export/*.json     ← API dump for the Phase 3 import test
├─ apps/web/                  ← Vite + React PWA
├─ supabase/                  ← migrations/, functions/, seed.sql, tests/
├─ devices/pi-station/        ← Python: scale, scanner, NIIMBOT print service (Phase 6b)
└─ scripts/                   ← import-sheet.ts, import-grocy.ts
```
Keep the full **Grocy and Homebox source trees outside the repo** (they are large and would waste
Claude Code's context). Point to specific files only if a question comes up.

### 11.2 Accounts & values to prepare before Phase 0
| Item | Value to fill in |
|---|---|
| GitHub repo (private) | `github.com/<your-github-username>/gedara` |
| **Supabase account** | a **new, separate account on `ayeshmantha1991.24@gmail.com`** (the `ayeshmantha@gmail.com` account is used by another project, so keep them apart). This is only the *developer/admin* account; it is not an app login. |
| Supabase projects (in that account) | `gedara-staging` and `gedara-prod`, region **Singapore (ap-southeast-1)**, closest to Sri Lanka |
| Vercel project name (permanent, it becomes the URL) | `gedara` → `gedara.vercel.app` (fallback `gedara-home`) |
| Household | name "Gedara", currency LKR, timezone Asia/Colombo |
| **App users (Supabase Auth, email OTP)** | **Didula Ayeshmantha** — `ayeshmantha@gmail.com` — role `owner`<br>**Sandeepani Thennakoon** — `asithaathennakoon@gmail.com` — role `member` (full edit) |
| A4 sticker sheet | standard A4, 6 rows × 9 columns (54), landscape by default, verify with calibration print |
| NIIMBOT B1 roll | **20 × 20 mm** (synthetic/PET roll for kitchen jars, paper for dry storage) |
| Google account for the Drive overflow folder (Phase 5+) | **Deferred 2026-09-25:** all files stay in Supabase Storage until use nears ~70 % of the free 1 GB (Settings › Storage); pick the account then (default `ayeshmantha@gmail.com`) |

Seed note: Phase 0 creates the household and invites both emails. Invite = a row in
`household_invite (email, role)`; on first OTP login, a trigger adds the user to
`household_member` if their email matches. No sign-up page for anyone else. Disable public
sign-ups in Supabase Auth settings.

Secrets go in `.env.local` (git-ignored) and in Supabase/Vercel secret settings. The Supabase
**service-role key never goes in the web app** — only anon key + RLS.

### 11.3 Gotchas decided in advance
- **Login = email OTP code, not magic link.** On iPhone/iPad an installed PWA opens magic links
  in Safari, not in the app, so you would never end up logged in inside the PWA. A 6-digit code
  typed into the app avoids this.
- **iOS push notifications** only work after "Add to Home Screen" (iOS 16.4+). The Attention feed
  must work without push.
- **Camera scanning** needs HTTPS (fine on Vercel) and a user tap to start on iOS.
- **Free Supabase allows 2 active projects** — staging + prod uses both.
- **Auth email delivery:** Supabase's default SMTP only sends to org team members, 2/hour. Both
  projects use **custom SMTP through Gmail** (`ayeshmantha1991.24@gmail.com`, App Password,
  `smtp.gmail.com:587`), with the auth email rate limit set to 30/hour.
- **Vercel first import** uses Root Directory `apps/web`, so the planning docs (which contain
  personal emails) are never deployed as static files.
- **No Docker on the dev PC** is allowed: then develop and test against `gedara-staging`, never prod.
- **Supabase MCP in Claude Code:** connect it to **staging** with full access; connect prod
  read-only or not at all. Schema changes reach prod only through migration files.

### 11.4 How to run each phase in Claude Code
1. Start a fresh session per phase. Prompt: *"Read CLAUDE.md and docs/MASTER_PLAN.md §9 Phase N.
   Enter plan mode and propose the plan before writing code."*
2. Approve the plan, let it build, and make it run tests + deploy a Vercel preview.
3. Check the preview yourself on laptop **and** iPad (version badge + Test connection first).
4. Merge → production. Add a line to `docs/decisions.md` for anything decided along the way.
