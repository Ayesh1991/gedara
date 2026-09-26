# Changelog

## 0.7.0 — Phase 7 AI & polish
- **Works offline for scan-and-consume.**
  - The app starts with no signal: the service worker serves the app, and the products, barcodes,
    places, shopping list and membership are saved on the phone (IndexedDB, up to 7 days).
  - Scanning a product or place label or a known barcode works offline, and so do use, −1, open,
    move and waste, and shopping-list ticks. They wait in an **outbox** on the phone and sync in
    order when it's back online.
  - Every stock action now carries an id made when you tap (`rpc_stock_op`), so a retry or replay
    never takes stock twice.
  - If the other phone got there first (e.g. it used the last one), the action is **parked** in
    "Couldn't sync" on Pantry with "Use what's left" / "Discard". Nothing changes silently.
  - An older offline tick never overrides a newer change.
  - An offline banner shows the count, the Pantry tab shows a badge, and Diagnostics shows the queue.
  - Fixed a Phase 0 bug: the service worker's offline warm-up had never run (duplicate icon URLs
    made `Cache.addAll` reject everything). It now caches file by file with a retry, and matches
    cached files even when a server sends `Vary: Origin`.
  - Offline start is reliable: the saved catalogue is restored before routing begins, saved data
    survives failed refreshes, and it is always refreshed once the screen opens (so a reload never
    shows yesterday's stock as current).
  - An action queued behind another that is waiting for the network is never dropped: if it's
    refused later, it goes to "Couldn't sync".
- **Scanned files from Google Drive** (Money › Import › From Drive).
  - The claude.ai Bill Scanner project keeps saving JSON into your Drive folder. The `drive-scan`
    Edge Function reads that folder with a read-only Google service account, Zod-validates each
    file (Google Docs are read as text), and lists it here.
  - Bills open in the usual import review. Warranty cards and appliance rating plates fill in a
    new or existing thing, matched by serial number, then model.
  - Home shows "N scanned files to import", and so does the 07:00 summary.
  - New instructions for the claude.ai project are in `docs/bill-scanner-project.md`.
  - **Android: Share → Gedara** from the Claude app opens the shared JSON in Import.
- **Open Food Facts**: a new barcode's product form is prefilled with name, brand, pack size,
  a category guess and an optional photo. You're asked to check it.
- **Labels**:
  - HL:LOT labels for one pack or freezer bag ("EXP 26-10"). Scanning one uses that very pack.
  - **Mini 10 mm** labels (raw-code QR only) for small items, as NIIMBOT PNGs or an A4 mini sheet
    with its own saved grid.
- **Swipe on pantry cards** (off until you turn it on in Settings › Appearance):
  - right = use the usual amount
  - left = use all
  - hold = more actions
  All three have the 8 s Undo.
- **Places floor plan**: a picture per floor with rooms pinned on it. Drag the pins, or move them
  with the arrow keys. Tap a pin to open the room.
- **Export & backup** (Settings › Export): one zip with every table as JSON and CSV, plus photos
  and documents. Home reminds you when the last backup is over a month old.
- **Sinhala (සිංහල)**: every screen is translated. The language is chosen per person in Settings ›
  Appearance and synced across devices, and the Noto Sans Sinhala font is loaded only when Sinhala
  text is on screen. Dates follow the language; amounts stay Rs (en-LK).
- **Checks**:
  - `scripts/pwa-check.mjs` stands in for Lighthouse's removed PWA audit: 24/24 on a local build,
    including offline start.
  - Lighthouse: performance 83 on a local build, the same as v0.6.0 built the same way;
    accessibility 100 (the login page now has a main landmark); best practices 100.
- Migrations 50–55: `stock_op`, `shopping_tick`, `lot_code`, `floor_plan`, `scan_inbox`,
  `export_attention`. Edge Functions: `drive-scan-1` (new) and `attention-push-2` (new Attention kinds).

## 0.6.0 — Phase 6 Insights & Attention
- **Every number is a link** down to the record. Insights (`/insights`) has seven areas, and the
  drill path is kept in the URL (`/insights/spend?from=2026-09&cat=…&sub=…&name=…`), so any view
  can be bookmarked or opened on another device:
  - **Cash flow**: in vs out, savings rate, budget vs actual, recurring vs other spending, balances
    over time.
  - **Spending**: category → sub-category → product or bill-line name → the bill lines. You can
    also group by shop, account, "paid with", or a day × hour heatmap.
  - **Prices**: Rs per unit over time, comparison between shops, and a **personal inflation index**
    from your own basket (chain-linked, weighted by spend, with no CCPI).
  - **Pantry**: bought vs used vs wasted, waste by category with spoil rate, when things run out,
    and stock value by place.
  - **Things**: cost vs worth now, insured vs not, cost per month, and warranty and service
    calendars.
  - **Utilities**: units and the real Rs per kWh / m³ from recurring bills, and how long an LP gas
    cylinder lasts.
  - **Places**: what each place holds and is worth, and what hasn't moved in 12 months.

  A bill line opened from Insights is highlighted on its bill (`?line=`). The stock journal filters
  by product, reason and dates.
- **Attention** (`/attention`, the Home card and the bell's badge) comes from the database and
  covers:
  - food that has expired, is past best-before or is due within 5 days
  - products below minimum or running out within 5 days
  - recurring bills and insurance renewals that are due or overdue
  - warranties ending within 30 days, and services due
  - things still to enter, and bank alerts still to review
  - budgets at 90 % or over

  Items can be hidden until tomorrow, for a week, or until they change. Undo is available.
- **Daily notification at 07:00** (Web Push) on the devices you turn it on for, in Settings ›
  Notifications. It works on Android Chrome, laptop Edge / Chrome, and iPhone / iPad from the
  Home-Screen app. There is a test button. The `attention-push` Edge Function, run by `pg_cron`,
  sends one short summary and only when there is something to say. Diagnostics shows the job and
  its last run.
- **Recurring bills** (Money › Recurring): quick presets for CEB, water, phone, gas and insurance.
  They repeat every n days, weeks, months or years, with reminders a chosen number of days before.
  - **Pay** saves the expense and links it in one step, and can record the kWh / m³ used.
  - **Already in Money** links an SMS or scanned bill.
  - **Skip this time** is also available.
  - Due dates are computed, so deleting a payment makes the bill due again.
- **Budgets** (Money › Budgets): one amount a month per main category, carried over until you
  change it, with a "usual" suggestion. Home's Budget burn card and the Spent ring now use them.
- **Recent activity** on Home: bills added or deleted, stock actions (one entry per action),
  services, new products and places, and the life of things. Each entry opens its record.
- **⌘K / Ctrl+K palette** searches products (including Sinhala names and barcodes), things
  (A-number, model, serial), places, bills, bill lines and categories, and runs commands.
  Shortcuts: `/`, `N`, `S`, `G` then `H/M/P/T/L/I/A`, and `?`.
- Database: migrations 40–49:
  - `pg_trgm`, `pg_cron`, `pg_net`
  - `recurring_rule`, `recurring_skip`, `meter_reading` and their RPCs
  - `budget`
  - activity triggers
  - the attention feed
  - `push_subscription` and `push_run`
  - Insights views
  - `search_all`
  - daily cron jobs

## 0.5.0 — Phase 5 Things
- **Things** (replaces Homebox): a photo gallery of what you own with its A-number (A-0042), where
  it is, and warranty / service / status chips. Search by name, A-number, serial, model or tag;
  filters (at home, needs attention, lent, in repair, stored, sold / gone) and tag chips; totals for
  "paid" and "worth now". Adding a thing asks 5 things (photo + name, category, place, price and
  date, warranty); the rest is under "More details": make, model, serial, quantity, condition,
  status, shop, useful life + salvage value (suggested per category), insured, **part of** another
  thing, **tags**, notes and the category's own **fields** (Settings › Fields for things; starter
  fields for Electronics, Home appliances, Furniture, Books, Tools).
- **Bought, not entered yet**: bill lines that go to Things (appliances, electronics, furniture …)
  wait on the Things page, Home and the bill page. "Add to Things" prefills name, price, date and
  shop from the bill and links the thing to its line; "Not a thing" keeps the line as an expense
  only (with Undo). Clothing, footwear and gifts no longer go to Things by default. A line with a
  thing keeps its lines when the bill is edited; deleting the bill keeps the thing.
- **Thing page**: value now (straight-line depreciation), cost of owning it (price + services −
  sale) in total and per month, details and custom fields, parts, **receipts and documents** (photos
  or PDFs up to 10 MB; the receipt of the bill it was bought on shows too), and its **history**
  (bought → moved → lent → returned → sold). Actions: move (with its parts, or by scanning the
  place's label), lend / got it back, **service plan** (every 6 months …, next due), **log a service
  or repair** — the cost becomes an expense in Money (Services › Repairs & maintenance, or the
  plan's category) or is linked to an expense already there (SMS / scanned bill), so nothing is
  counted twice — **sell** (the income goes to Money under Income › Sale of belongings; Undo takes
  both back) or "gave it away", split "6 chairs" into 6, delete with Undo.
- **Labels and scanning**: asset labels on the NIIMBOT 20 mm (raw HL:AST code + A-number) and the
  A4 sheet (URL QR + name + A-number · place); scanning a thing's label opens it (camera, USB
  scanner, or the phone's own camera through /s/HL:AST:…).
- Places show the things kept there; Home shows what your things are worth and, under Attention,
  services due within 7 days, warranties ending within 30 days and things still to enter. Bills get
  a **Receipt and documents** section. Settings › **Storage** shows how much the photos and
  documents take (Google Drive overflow deferred until it nears 70 % of the free 1 GB).
- Supabase migrations 33–39: `asset` (HL:AST code, never-reused A-number, bill-line link with price
  / date / shop defaults (GDLIN), sold guard (GDSLD)), `tag` + `asset_tag` + `category_field` +
  `attachment.title`, `maintenance_plan` + `maintenance_log` (next due follows the logs), `activity`
  (asset timeline, written by triggers), `rpc_log_maintenance` / `rpc_delete_maintenance_log` /
  `rpc_asset_sell` / `rpc_asset_unsell` / `rpc_asset_split` + guards on bill lines with things
  (GDRTD) + deleting a sale's income brings the thing back, category data (clothing / footwear /
  gifts expense only, "Sale of belongings"), views `v_asset`, `v_asset_pending_line`,
  `v_maintenance_due`, `v_storage_usage`. schema_version = 39.
- pgTAP: 46 isolation assertions (every new table and view, viewer read-only, codes / A-numbers /
  sale columns / logs / timeline never client-written) and 56 behaviour assertions (bill → thing,
  GDLIN, GDRTD, parts can't loop, service → expense create / link / delete and next due, sell /
  unsell / delete the income, split, lend / return / move timeline, A-numbers never reused, value
  and cost of ownership). Vitest: depreciation, months like Postgres `age()`, warranty states, field
  templates and value checks, PDF / image sniffing. Playwright: the done-when replay (TV from a bill,
  fridge, laptop, receipts, warranty dates, AC service → expense) plus lend, sell + Undo, label and
  deep link, on phone + iPad.

## 0.4.0 — Phase 4 The spine
- **One bill, one confirm** (Money › Import › Scanned bill): each line now shows where it goes:
  **Pantry** (a lot of a product, priced from the line: "1 pack = 10 pcs · Rs 57.00 / pcs"),
  **Things** (kept for Phase 5) or **Expense only**. Import logs the expense, creates the lots
  (bought on the bill date, product's place and due date unless changed) and ticks the shopping
  list, all at once, with an 8 s Undo (= delete the bill again).
- **Product matching**: barcode printed on the bill → a bill name learned before → name similarity
  (pre-selected in amber "check" when close; only suggested when ambiguous or in another category).
  Lines without a match offer "New product" (prefilled) or "Not stock" right in the row; lines left
  without a product don't block the import (they're saved as plain bill lines, "Send to pantry"
  later); a unit the product can't convert asks "how much is 1 pcs?" and saves the pack size.
  Importing one bill opens its page.
- **Learning**: every confirmed line teaches its printed name ("WHITE SUGAR 1KG" → Sugar), also
  "not stock" (bottled water). The product page lists its **names on bills** (removable) and
  **prices by shop** (Rs per kg / L / pc, cheapest highlighted).
- **Bill page**: each line shows where it went ("In the pantry: Sugar" links to the product;
  "Goes to Things (Phase 5)"); **Send to pantry** routes lines of a bill that's already in Gedara
  (SMS / manual / imported before its products existed). Editing a bill whose lines feed the pantry
  changes the header only. Deleting a bill takes its unused stock back; if some was used, you can
  delete it and keep the stock.
- **Shopping list** (Pantry › List): products and free text, quantities, "have 200 g",
  "cheapest recently Keells Rs 480 / kg", bought items with the bill they were bought on. Products
  below their minimum are added by themselves ("low"; "Not now" hides one). Live between phones.
  Home's Attention card and the Pantry header show how much is on it; product pages have "To list".
- Supabase migrations 28–32: `product_alias` (+ `private.bill_name_norm`), `transaction_line.product_id`
  + `v_line_route`, `shopping_list_item` (+ Realtime, `rpc_shopping_sync`), bill routing
  (`rpc_import_bills` routes lines, `rpc_route_lines`, header-only edits of routed bills (GDRTD),
  `rpc_delete_transaction(p_id, p_keep_stock)` taking stock back (GDUSE)), `v_product_price`,
  `v_shopping_list`; `v_product_stock`'s last price skips taken-back purchases. schema_version = 32.
- pgTAP: 48 routing assertions (lots, conversions, unit cost, dates, learning, ticks, duplicates,
  cross-household ids, routing an existing bill, locked lines, delete / keep stock, prices by shop,
  Σ delta invariant), 36 alias + shopping-list isolation / sync assertions. Vitest: bill-name
  normalisation (same as SQL), matching tiers, routes, previews, summary, list order. Playwright:
  the done-when bill (8 lots, 3 ticks, one confirm) and delete, and a shopping-list round trip, on
  phone + iPad.

## 0.3.0 — Phase 3 Pantry core
- **Pantry** (replaces Grocy, fresh start, no import): stock overview with search, filter chips
  (needs a look / expired / past best-before / due soon / running low / opened / out / archived),
  stat tiles (in stock, stock value with "N without a price", needs a look), product cards with a
  one-tap −1 and a ⋯ menu (Add / Use / Open / Move / Count / Waste), each with an 8 s Undo.
- **Products**: ≤ 5 fields (name, category, counted-in unit, usual place, dates) + "More details"
  (Sinhala/Tamil name, bought-as unit with "1 pack = 400 g", minimum, quick-use amount, days once
  opened / in the freezer, photo). A new product copies the settings of the last one in its category.
  Every product gets an HL:PRD label code (A4 + NIIMBOT labels from the product page).
- **Product page**: stock, value, price per kg / L / pc, lots in FEFO order (place, due, opened,
  cost) with Use / Open / Move / "Still fine +30 days" / Change date, barcodes and pack sizes, history.
- **Stock journal** (Pantry › Journal): every movement, grouped per action, Undo once.
- **Scan**: product labels and barcodes open the product with Use / Add; an unknown barcode offers
  "New product" (prefilled) or "Add to a product"; old Grocy labels say so. Place pages list the
  stock kept there. Home shows the real pantry value.
- **Units** (Settings › Units): household units (tin, sachet, dozen = 12 pcs); sizes never change.
- Supabase migrations 22–27: household units, `product`, `product_barcode` + `product_unit_conversion`,
  `stock_lot` + append-only `stock_movement`, stock RPCs (purchase / consume / open / transfer /
  inventory / set due / undo; FEFO, row locks), `v_stock` / `v_product_stock` / `v_stock_journal`.
  schema_version = 27.
- pgTAP: 56 stock-RPC assertions (conversions, FEFO across 2 lots, opened first, splits, freezer,
  inventory, undo + refusal, Σ delta invariant), 34 product/unit/barcode isolation, 26 stock isolation.
  Vitest: unit conversion, display, status chips. Playwright: product → 2 lots → FEFO use → Undo →
  journal → scan, on phone + iPad.

## 0.2.1 — Phase 2b Bank SMS import
- **Bank alerts inbox** (Money › Alerts): every bank / card SMS lands here first; nothing reaches the
  ledger until someone confirms it. Suggestions per alert: link to the scanned bill or Sheet row it
  belongs to (a bill waiting in "Card — to be matched" moves to the card the alert names), BOC debit +
  card payment → one transfer with its Rs 25 CEFT fee (either order, up to 36 h apart), ATM → Cash,
  money in → income, anything else → a new expense (category remembered per merchant). One gold
  "Accept N clear matches"; Reviewed tab with Undo; live updates via Realtime.
- **Balance checks**: each alert's "Balance available" / "Avl bal" is chained to the previous one
  (a jump flags a missed alert or a pending hold); USD card charges get their rupee cost from the
  drop in available credit; account pages show "Bank said … / Gedara …".
- **Phone forwarding** (Settings › SMS forwarding, owner only): add an Android phone, copy the ready
  settings for the open-source "SMS to URL Forwarder" app (URL, secret header, JSON template, sender
  allow-list, OTP-blocking text filter); last seen / counts / rejected sender; remove = token dead.
- **SMS backup import** (Money › Import › Bank SMS): an "SMS Backup & Restore" .xml is filtered in the
  browser (bank senders only, no OTPs / promos / personal messages) and sent through the same parser.
- Parsers for BOC savings + BOC card, Sampath, People's and Seylan (all real formats seen so far);
  unknown formats from these senders are kept as "New kind of alert".
- Edge Function `sms-ingest` (sms-ingest-1): device token (sha256 only in the DB) or signed-in user,
  Zod, size caps, OTP / promo drop, counts-only replies and logs. Diagnostics shows its version.
- Supabase migrations 18–21: `sms_device`, `sms_message`, SMS RPCs (+ `rpc_save_transaction` now
  wraps `private.save_transaction`), `v_sms_balance_check`. schema_version = 21.
- pgTAP: 41 SMS assertions (isolation, owner-only devices, hidden token hash, service-role-only
  device ingest, OTPs never stored, dedupe, link/post/ignore/unlink). Vitest: parsers on every real
  sample, matcher, backup reader. Playwright: import → link → transfer + fee → balances → phone
  forwarding, on phone + iPad.

## 0.2.0 — Phase 2 Money core
- **Money**: month view with In / Spent / Net, account strip, ledger-style list grouped by day with
  search + account / category filters; transaction page with lines, Rs per kg / L, fingerprint, edit
  and delete (8 s Undo).
- **Add**: expense / income / transfer in one sheet (≤ 5 fields, ledger v7 quick tiles, split into
  lines, optional bank fee on transfers); a repeat of the same entry asks "save another?".
- **Accounts**: Cash, BOC Savings, four credit cards (limits, owed, available, % used) and
  "Card — to be matched"; starting balance (cards from the SMS "Avl bal"), reconcile via a
  correction entry, bulk-move matched card bills; balances are always computed.
- **Import**: Bill Scanner JSON (files or paste; HTML/Google-Doc and bad shapes rejected, ledger v7
  fingerprints so repeats show "Already imported", discount/rounding line so totals match) and the
  old ledger Sheet CSV with a per-month reconciliation (to the rupee).
- **Categories** settings (ledger v7 set + Income), Home Net / Spent tiles and 6-month cash flow
  from real data.
- Supabase migrations 11–17: `unit`, `category` (+ seed), `merchant`, `account` (+ seed),
  `money_transaction` + `transaction_line`, write RPCs, balance / cash-flow views. schema_version = 17.
- pgTAP: money master data + transactions (isolation, viewer read-only, RPC rules, balances).
  Vitest: fingerprints against all 240 Sheet line ids and the 5 scanner samples, Sheet parser
  reconciliation, bill schema, dates. Playwright: the Phase 2 flow on phone + iPad.

## 0.1.0 — Phase 1 Places & Scanning
- **Places explorer**: rooms → furniture → boxes as photo tiles with counts; drill-in pages with
  breadcrumb, kind/climate chips, the place's QR code, add inside / edit / move / delete (8 s Undo);
  honest "arrives in Phase 3 / 5" panels for pantry and things. Places card on Home, row in Settings.
- **Photos**: magic-byte check, resized in the browser to WebP 1600 px + 320 px thumbnail (WASM
  encoder fallback where the browser can't encode WebP, e.g. Safari), private bucket + signed URLs.
- **Labels**: A4 sheet PDF for the Epson (6 × 9 landscape, URL QR + name + breadcrumb, partial-sheet
  start cell, calibration page, per-printer offsets saved for the household); NIIMBOT 20 × 20 mm
  1-bit 203 dpi PNGs (raw code, QR version 1-M) to print from the NIIMBOT app.
- **Scan**: camera HUD (native BarcodeDetector, self-hosted zxing-wasm fallback, torch, rapid-fire
  with repeat debounce), typed code, USB keyboard-wedge scanner on every screen (result toast).
- **Deep links** `/s/<code>` open the place; signed-out visitors return there after login.
- Supabase migrations 7–10: HL code generator, `location` (immutable unique codes, same-household
  parents, no cycles, trigger-kept paths), `attachment`, `label_profile`. schema_version = 10.
- pgTAP: location / attachment / label_profile isolation tests. Vitest: codes, QR, sheet geometry,
  PDF, 1-bit PNG, wedge, tree, image sniffing, redirect. Playwright: the full Phase 1 flow.

## 0.0.2 — Aurora redesign + colour themes
- New design language "Aurora": drifting aurora light, glass rail/cards, floating phone dock with a gold Scan orb,
  page transitions, count-up numbers (all respect Motion / reduced-motion).
- Settings › Appearance: 5 aurora themes (Aurora, Nebula, Lagoon, Ember, Mono) + Motion; synced per user.
- Home "Pulse": KPI tiles, cash-flow, budget, attention and activity panels with honest empty states.
- Redesigned sign-in; ⌘K / search and notifications show what's coming; version badge no longer wraps.

## 0.0.1 — Phase 0 Foundation (in progress)
- pnpm workspace; `apps/web` = Vite 8 + React 19 + TS 6 (strict) + Tailwind 4 + shadcn-style UI,
  TanStack Router (file-based) + Query, supabase-js, Zod, i18next (`en`).
- Ledger v7 design tokens + self-hosted Space Grotesk / IBM Plex Mono.
- Network-first service worker (injectManifest), version-stamped caches, update toast.
- Email-OTP login (invite-only), not-invited screen, 5-tab shell (bottom bar / left rail).
- Diagnostics: version + git SHA + DB schema_version + SW version; Test connection
  (Auth, DB, Storage, Realtime, Edge fn, SW); clear cache & reload.
- Supabase migrations 1–6: app_meta/schema_version, household tenancy + RLS helpers,
  invite-on-signup trigger, `household-files` bucket + storage RLS, Gedara household seed,
  RLS helpers moved to the non-exposed `private` schema. schema_version = 6.
- pgTAP tests (tenancy, invites, storage, app_meta), Vitest units, Playwright e2e.
- Edge Function `ping` (ping-1).
