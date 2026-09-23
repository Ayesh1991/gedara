> **SUPERSEDED** by `docs/MASTER_PLAN.md` (schema, phases). Kept for history only — do not implement from this file.

# Home System — Architecture & Build Brief

A unified household platform combining **expense ledger**, **inventory / stock management**
(groceries, consumables, electronics components, anything in a container), and
**physical location tracking via QR/barcode**. Built to be handed to Claude Code as
a build brief, module by module.

---

## 1. Design principles

1. **One source of truth, event-sourced stock.** Current quantity is never edited
   directly — it is always the sum of immutable `stock_movement` rows. This gives
   a full audit trail, safe undo, accurate consumption analytics, and "what did we
   have on date X" for free.
2. **Item ≠ Stock.** An **Item** is a definition ("10kΩ resistor, 0805 package" /
   "White sugar"). **Stock** is how many of that item exist, and where, right now.
   Never conflate the two — this is the single decision that lets groceries and
   electronics share one schema.
3. **A purchase is a stock-in event.** The existing Home Ledger bill-scan workflow
   becomes the front door for grocery/consumable stock: importing a bill both logs
   the expense AND increases stock, in one action.
4. **Locations are a tree.** A drawer lives inside a locker lives inside a room.
   One recursive table, not a special case per level.
5. **Everything scannable resolves through one router.** Camera scan and USB
   barcode-scanner input both emit the same "code scanned" event; a single
   resolver decides whether it's a location, an item, or an unknown barcode.
6. **Mobile-first, installable, offline-tolerant.** Same PWA discipline as the
   ledger: network-first service worker (never repeat the caching bug), works
   one-handed while standing at a shelf.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript + Tailwind | Fast dev loop, static-hostable, Claude Code writes React well |
| UI components | shadcn/ui (Radix + Tailwind) | Accessible primitives, fully themeable to the existing dark/gold look |
| Backend | Supabase (Postgres + Auth + Storage + Realtime + Edge Functions) | One account covers DB, file storage, login, live sync, server logic |
| State/data | TanStack Query + Supabase JS client | Caching, optimistic updates, background refetch |
| Camera scanning | `barcode-detector` (native where available) + `zxing-wasm` fallback | Covers Chrome/Android natively, iOS Safari via WASM |
| USB scanner | Custom keystroke-timing listener (see §5) | No drivers needed — scanner is a keyboard emulator |
| QR/barcode generation | `qrcode` (npm) + `bwip-js` for barcodes | Client-side generation, no external API dependency |
| Label sheet PDF | `pdf-lib` | Print-ready bulk QR label sheets |
| Charts | Recharts (or reuse the ledger's hand-rolled SVG approach) | Consumption trends, stock levels, spend analytics |
| Hosting | Vercel or Netlify (or GitHub Pages if you prefer consistency) | Free tier, better PWA edge caching than GH Pages |

---

## 3. Module map

```
┌─────────────────────────────────────────────────────────┐
│                     Home System PWA                     │
├───────────────┬───────────────┬───────────────┬─────────┤
│   Locations    │     Items      │     Stock      │ Ledger  │
│  (QR tree)     │  (definitions, │  (live qty per │(expenses,│
│                │  photos, attrs)│  item+location)│  bills) │
└───────┬────────┴───────┬────────┴───────┬────────┴────┬────┘
        │                │                │             │
        └──────────┬─────┴────────┬───────┴──────┬──────┘
                   │  stock_movement (event log)  │
                   └───────────────────────────────┘
                              │
                   Analytics & Dashboards
        (consumption rate, reorder forecast, spend, waste)
```

---

## 4. Database schema (Postgres / Supabase)

```sql
-- ========== Auth handled by Supabase Auth (auth.users) ==========

-- ---------- Categories (shared taxonomy across ledger + inventory) ----------
create table category (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  parent_id     uuid references category(id),           -- nullable = top level
  icon          text,                                    -- emoji or icon key
  color         text,                                    -- hex, for charts/UI
  kind          text not null check (kind in ('expense','inventory','both')),
  created_at    timestamptz not null default now()
);

-- ---------- Locations (recursive tree: room > shelf > bucket > drawer) ----------
create table location (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  name          text not null,                           -- "Kitchen shelf A", "Electronics box 3"
  parent_id     uuid references location(id),
  qr_code       text unique not null,                     -- "HL:LOC:<short id>"
  photo_url     text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index on location(user_id);
create index on location(parent_id);

-- ---------- Item master (the definition, not the stock) ----------
create table item (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  name          text not null,
  category_id   uuid references category(id),
  unit          text not null default 'pcs',              -- kg, g, L, ml, pcs, unit(kWh)...
  barcode       text,                                      -- EAN/UPC if it has one
  internal_qr   text unique,                                -- "HL:ITM:<short id>" for non-barcoded items
  min_qty       numeric,                                    -- reorder threshold
  attributes    jsonb not null default '{}',                -- {resistance:"10k", package:"0805"} etc.
  photo_urls    text[] not null default '{}',                -- Supabase Storage URLs
  perishable    boolean not null default false,
  default_shelf_life_days integer,                          -- for auto-suggesting expiry on purchase
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on item(user_id);
create index on item(barcode);
create unique index on item(user_id, lower(name)) where barcode is null;  -- soft de-dup for unbarcoded items

-- ---------- Stock movement — the ONE append-only event log ----------
create table stock_movement (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  item_id       uuid not null references item(id),
  location_id   uuid references location(id),               -- null = "no fixed home" / consumed
  delta         numeric not null,                            -- +ve = in, -ve = out
  reason        text not null check (reason in
                  ('purchase','consume','adjust','waste','transfer_out','transfer_in')),
  unit_cost     numeric,                                     -- cost basis at time of movement
  expiry_date   date,                                        -- for this specific batch, if perishable
  batch_ref     text,                                        -- groups a multi-line purchase's movements
  purchase_id   uuid references purchase(id),                -- see §5, nullable
  note          text,
  created_at    timestamptz not null default now()
);
create index on stock_movement(item_id, location_id);
create index on stock_movement(user_id, created_at);

-- ---------- Live stock (materialized view, refreshed by trigger — fast reads) ----------
create table stock (
  item_id       uuid not null references item(id),
  location_id   uuid not null references location(id),
  quantity      numeric not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (item_id, location_id)
);
-- maintained by a trigger on stock_movement insert (see §4a)

-- ---------- Purchases (bill header — replaces/extends the old Sheet row) ----------
create table purchase (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  shop          text,
  purchase_date date not null,
  purchase_time time,
  invoice_no    text,
  payment_method text,
  subtotal      numeric,
  discount      numeric default 0,
  total         numeric not null,
  source        text not null default 'manual' check (source in ('manual','scan')),
  fingerprint   text unique,                                 -- content hash — the dedup fix, carried over
  created_at    timestamptz not null default now()
);

-- ---------- Purchase line items (the expense side) ----------
create table purchase_item (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references purchase(id) on delete cascade,
  item_id       uuid references item(id),                   -- null until matched/created
  raw_name      text not null,                                -- exactly as scanned, for audit
  category_id   uuid references category(id),
  qty           numeric,
  unit          text,
  unit_price    numeric,
  amount        numeric not null,
  fingerprint   text unique,                                 -- date|shop|item|qty|amount hash
  created_at    timestamptz not null default now()
);
```

### 4a. The stock-maintenance trigger

```sql
create or replace function apply_stock_movement() returns trigger as $$
begin
  insert into stock (item_id, location_id, quantity, updated_at)
  values (new.item_id, coalesce(new.location_id, '00000000-0000-0000-0000-000000000000'), new.delta, now())
  on conflict (item_id, location_id)
  do update set quantity = stock.quantity + new.delta, updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_stock_movement
  after insert on stock_movement
  for each row execute function apply_stock_movement();
```

### 4b. Row-level security (every table, same pattern)

```sql
alter table location enable row level security;
create policy "own rows" on location for all using (auth.uid() = user_id);
-- repeat for item, stock_movement, purchase, purchase_item
```

---

## 5. Scanning architecture

### 5a. Unified scan event

Both input paths funnel into one handler:

```
Camera scan (BarcodeDetector / zxing-wasm)  ─┐
                                               ├──► onScan(code: string) ──► resolveCode(code)
USB scanner (keystroke-timing buffer)        ─┘
```

```ts
function resolveCode(code: string) {
  if (code.startsWith('HL:LOC:')) return openLocation(code);
  if (code.startsWith('HL:ITM:')) return openItem(code);
  return lookupByBarcode(code);   // EAN/UPC → item.barcode match, else "unknown item" flow
}
```

### 5b. USB barcode-scanner detection (keyboard-wedge pattern)

USB scanners act as a keyboard: they "type" the code fast, then send Enter/Tab.
Distinguish from human typing by inter-keystroke timing:

```ts
let buffer = '';
let lastKeyTime = 0;
const FAST_THRESHOLD_MS = 30;   // human typing is much slower than this

window.addEventListener('keydown', (e) => {
  const now = performance.now();
  if (now - lastKeyTime > FAST_THRESHOLD_MS && buffer.length > 0) {
    buffer = '';                // gap too long → was human typing, reset
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (buffer.length >= 4) onScan(buffer);   // real scans are rarely under 4 chars
    buffer = '';
  } else if (e.key.length === 1) {
    buffer += e.key;
  }
  lastKeyTime = now;
});
```

This listens globally, so the USB scanner works from any screen without focusing
a specific input field — scan a location QR while browsing anywhere in the app.

### 5c. QR / barcode identifier scheme

| Type | Format | Example | Use |
|---|---|---|---|
| Location | `HL:LOC:<id>` | `HL:LOC:a1b2c3d4` | Printed on every bucket/locker/drawer |
| Item (no real barcode) | `HL:ITM:<id>` | `HL:ITM:f00dcafe` | Electronics parts, home-made labels |
| Product barcode | raw EAN/UPC | `4791234567890` | Groceries — captured as printed |

### 5d. Bulk QR generation & printing

- Batch-generate N location or item QR codes at once (e.g. "give me 40 container labels").
- Render to a print-ready PDF grid (`pdf-lib`), sized for standard label sheets or a
  plain grid for home printing — include the human-readable name under each code.
- Each generated code is inserted into `location`/`item` immediately (not just an
  image) so scanning it "just works" the moment it's printed and stuck on.

### 5e. Barcode lookup for unknown groceries

When a scanned EAN/UPC doesn't match any `item.barcode`, call a public product
database (e.g. Open Food Facts API) via a Supabase Edge Function (keeps API keys
server-side) to prefill name/photo/category, then let the user confirm and save
as a new `item`. This is the "commercial-grade" touch Grocy doesn't do as smoothly.

---

## 6. Purchase → Stock flow (the piece that ties Ledger and Store together)

1. Bill photographed → uploaded to the existing **Bill Scanner** Claude project (unchanged workflow).
2. Claude returns JSON (same schema as today, extended with an optional `location_hint` per item).
3. Import screen (Home System, not the old ledger app) shows each line:
   - matched against `item.barcode` or fuzzy name match against existing items,
   - unmatched lines prompt "create new item?" with category/photo/location.
4. On confirm:
   - one `purchase` row + N `purchase_item` rows (the expense),
   - one `stock_movement` row per line with `reason='purchase'` (the stock-in),
   - if the item is `perishable`, `expiry_date` is prefilled from `default_shelf_life_days`
     and editable before saving.
5. `stock` table updates automatically via the trigger — no separate step.

**Consuming** an item (using sugar, using a resistor) is the mirror action: scan the
item (or pick it from its location's list) → enter quantity used → `stock_movement`
with `reason='consume'`, `delta` negative. This is also where "waste/expired" gets
logged separately (`reason='waste'`) so waste is visible in analytics, not silently
merged into "consumed."

---

## 7. Analytics (what makes this "advanced," not just Grocy-plus-QR)

| Dashboard | Query basis | Insight |
|---|---|---|
| Low stock | `stock.quantity < item.min_qty` | Reorder list |
| Expiring soon | `stock_movement.expiry_date` within N days, not yet consumed | Waste prevention |
| Consumption velocity | rolling average of `consume` movements per item per week | "You go through sugar every 9 days" |
| Days-to-empty forecast | current stock ÷ consumption velocity | Predictive reorder, beyond what Grocy offers |
| Unit price trend | `purchase_item.unit_price` over time (already built in the ledger) | Inflation tracking, already proven to work |
| Spend by category/location | sum of `purchase_item.amount` grouped | Existing ledger insights, carried forward |
| Waste cost | sum of `stock_movement.unit_cost * -delta` where `reason='waste'` | Rs lost to spoilage — a number Grocy doesn't surface well |
| Location utilization | item count / distinct items per `location_id` | Which containers are actually full vs empty |

---

## 8. Migration from the current Home Ledger

- Existing Google Sheet rows import once into `purchase` + `purchase_item` via a
  script, **carrying over the existing fingerprint hashes** as the `fingerprint`
  column — this preserves the dedup guarantee already battle-tested in the ledger.
- The Bill Scanner Claude project's instructions and JSON schema stay unchanged;
  only the *import destination* changes from "paste into PWA → push to Sheet" to
  "paste into PWA → insert into Supabase."
- The ledger's category list and colors transfer directly into the `category` table.

---

## 9. Phased build plan (for Claude Code, one phase at a time)

**Phase 0 — Foundation**
Supabase project, schema above, RLS policies, Auth (email/magic link), Vite+React
shell with the ledger's dark/gold design system ported over.

**Phase 1 — Locations**
CRUD + tree view, QR generation (single + bulk), PDF label sheet export, camera
+ USB scan → open location.

**Phase 2 — Items & Stock**
Item CRUD with photo upload (Supabase Storage), barcode/QR resolution, stock view
per location, manual stock adjust.

**Phase 3 — Purchases (Ledger integration)**
Import screen wired to Supabase, purchase↔stock_movement creation, migration
script for existing Sheet data.

**Phase 4 — Consumption & waste**
Scan-to-consume flow, expiry tracking, waste logging.

**Phase 5 — Analytics**
Dashboards from §7, reuse/extend the ledger's existing chart components.

**Phase 6 — Polish**
Offline handling, install prompts, bulk operations, label templates, PWA
network-first service worker (carry forward the lesson already learned).

---

## 10. Open decisions to make before Phase 0

- **Hosting:** Vercel/Netlify (recommended) vs staying on GitHub Pages.
- **Single-user vs household multi-user:** Supabase Auth supports both; decide
  now whether a spouse/family member gets their own login or you share one.
- **Label sheet format:** specific printer/label stock you'll use, so the PDF
  grid dimensions are right the first time.
