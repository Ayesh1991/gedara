# Home System — Project Handover

**Purpose of this document:** everything needed to pick up this project in a new
chat with no prior context — what already exists and works, what's being built
next, and every hard-won lesson from getting there. Read this fully before
making architecture decisions.

---

## 1. Who this is for

Didula — a doctor in Sri Lanka, building this as a personal household tool.
Non-negotiable constraints that shaped every decision so far:
- LKR/Rs currency, Sri Lankan grocery/retail context (Cargills, LAUGFS, keeri
  samba rice, etc.)
- Used across multiple devices (laptop + iPad, possibly more later)
- Wants something genuinely **advanced and polished** — not a toy — but built
  and maintained solo, so every layer needs to be debuggable without a team.

---

## 2. What already exists and works: "Home Ledger" (v7, shipped)

A single-file HTML PWA for household expense tracking. **This is live and in
daily use** — it is not a prototype to throw away, it's the foundation the new
"Home System" absorbs and extends.

### Architecture
- **Frontend:** one self-contained `index.html` — vanilla JS, no build step,
  no external JS dependencies. Dark navy/gold "futuristic" design system.
  Hand-rolled SVG for all charts (bar, line, donut) — no chart library.
- **Hosting:** GitHub Pages.
- **OCR input:** a Claude Project ("Bill Scanner") with custom instructions —
  photograph a receipt, upload to that project, Claude returns structured JSON
  (shop, date, time, items with category/subcategory/qty/unit/price/amount).
- **Storage/backend:** Google Drive (a `Home Ledger Bills` folder holds the
  scanned JSON files) + Google Sheets (the shared database) + a Google Apps
  Script Web App (glue between the PWA and both Google services).
- **Sync:** the PWA calls the Apps Script Web App to (a) pull new bill JSONs
  from the Drive folder, (b) pull the full ledger from the Sheet, (c) push
  local unsynced entries to the Sheet. Two-way, multi-device.
- **Offline:** installable PWA, network-first service worker (see §4 for why
  this specific detail took 7 versions to get right).

### Categories (carry these over unchanged — already tuned to real usage)
Grocery (Rice, Sugar, Meat, Fish & seafood, Dairy & milk, etc.), Consumables,
Non-consumables, Energy (Petrol, LP Gas, Electricity), Water, Services
(Insurance, Telecom), Dining out, Transport, Other.

### Current known gap
Drive-based auto-import of scanned bills has been fragile (see §4) — Google's
Drive connector sometimes saves Claude's JSON output as a Google Doc instead
of a plain `.json` file, which needed special handling to read.

---

## 3. What's being built next: "Home System" (architecture designed, not yet built)

Expansion from pure expense tracking into a unified platform:

**Home Ledger (existing)** + **Grocy-like home inventory/stock management**
(groceries, consumables, AND small parts — resistors, capacitors, ICs, diodes
in labelled containers) + **QR/barcode-tracked physical storage locations**.

### Key architectural decisions already made
- **Backend: Supabase** (Postgres + Auth + Storage + Realtime + Edge
  Functions) — replacing the Google Sheets/Drive/Apps Script stack for this
  new system. One account, real relational queries, proper file storage for
  item photos (Drive/Sheets were evaluated and rejected for this — see §5).
- **Frontend: Vite + React + TypeScript + Tailwind**, built as an installable
  PWA. Will be built with **Claude Code** (not hand-written in chat like the
  original ledger).
- **Hardware already owned:** a USB QR/barcode scanner (keyboard-emulation
  type — see §5 for the detection approach).
- **Core data principle:** stock is never edited directly — it's always the
  sum of an immutable `stock_movement` event log (purchase / consume / adjust
  / waste / transfer). This is what makes analytics, undo-safety, and audit
  trail possible without extra engineering.
- **Item ≠ Stock:** an Item is a definition ("10kΩ resistor, 0805"); Stock is
  how many exist, where, right now. Keeping these separate is what lets
  groceries and electronics components share one schema.

### Full technical spec already written
A complete architecture document exists covering:
- Full Postgres schema (`category`, `location` as a recursive tree, `item`
  with a `jsonb attributes` field for arbitrary per-item data, `stock_movement`,
  `stock` materialized-by-trigger, `purchase` / `purchase_item`), including the
  stock-maintenance trigger and row-level-security policy pattern.
- QR/barcode identifier scheme: `HL:LOC:<id>` for locations, `HL:ITM:<id>` for
  non-barcoded items, raw EAN/UPC for real product barcodes.
- Dual scanning input: phone camera (`BarcodeDetector` API + `zxing-wasm`
  fallback) AND the existing USB scanner, unified through a keystroke-timing
  buffer (fast character bursts + Enter = a scan; normal typing speed = not a
  scan) so the USB scanner works globally with zero pairing/drivers.
- Bulk QR generation → printable PDF label sheets (`pdf-lib`).
- Purchase→stock flow: importing a scanned bill both logs the expense AND
  creates `stock_movement` rows — buying and stocking become one action.
- Analytics beyond basic Grocy: consumption velocity, days-to-empty forecast,
  waste-cost tracking, unit-price trend (already proven useful in the ledger).
- A six-phase build plan for Claude Code (Foundation → Locations → Items/Stock
  → Purchases/Ledger integration → Consumption/waste → Analytics → Polish).

**→ This full spec should be re-attached/pasted into the new chat as a
separate document if it isn't already available there. If it's missing, ask
Didula for the "SYSTEM_ARCHITECTURE.md" file from the previous chat before
proceeding — don't re-derive the schema from scratch.**

### Open decisions not yet made (resolve these in the new chat)
1. **Hosting** for the new system — Vercel/Netlify recommended over GitHub
   Pages (better PWA edge-caching behaviour), but not finalized.
2. **Single-user vs household multi-user** — Supabase Auth supports both;
   decide whether other household members get their own login.
3. **Physical label format** — specific printer/label stock, so bulk QR PDF
   sheets are sized correctly from the first print run.
4. **Label/expiry OCR approach** — evaluated options (see §5): recommended
   starting point is extending the existing Claude Bill Scanner pattern to
   product labels (paste-in JSON, same as bills) rather than building a live
   in-app OCR pipeline, which would need a paid API call per scan. Tesseract.js
   (free, client-side) was suggested as a first-pass fallback for clean flat
   text like printed price tags, but is weak on curved/embossed expiry dates.

---

## 4. Hard-won operational lessons (do not repeat these mistakes)

These cost real debugging time on the original ledger — they generalize to
any web app + cloud backend + PWA setup, so they apply directly to the new
Supabase/React build too:

- **"Saved" ≠ "deployed."** With Google Apps Script, saving code never updates
  the live Web App — a new deployment version must be explicitly published.
  The equivalent risk with Supabase Edge Functions / Vercel: always confirm a
  deploy actually went live, don't assume a git push == production update.
- **Service workers cache aggressively and silently.** A cache-first strategy
  meant the app kept serving v1.0 for six versions while GitHub had v6 — the
  user was debugging phantom bugs that were actually stale cache. **Use a
  network-first service worker from day one** on the new PWA; never repeat
  this.
- **Always build in a visible version indicator + a connection/diagnostics
  test button.** This was the single most useful debugging tool across the
  whole project — it turns "why isn't this working" into "which layer is
  stale" in five seconds. Build this into Home System from the start.
- **Deduplication must be deterministic, not random.** The original ledger's
  multi-device duplicate problem was solved by hashing bill content (date,
  time, shop, invoice, total) into the entry ID itself, so the same real-world
  bill produces the identical ID no matter which device imports it — rather
  than relying on random UUIDs and hoping sync logic catches duplicates. This
  principle should be designed into `purchase.fingerprint` and
  `purchase_item.fingerprint` from the start in the new schema (already
  reflected in the spec — don't remove it during implementation).
- **A cloud connector's output format can silently change.** Claude's Drive
  connector sometimes wrote Google Docs instead of plain JSON files, which
  broke JSON parsing silently. Don't trust a file's extension — verify MIME
  type / content shape defensively wherever an external integration writes
  files the app later reads.
- **Debug in layers, cheapest check first:** app version visible → is the
  right code even deployed? → is the backend/script the right version? →
  is it a cache problem? → only then look at actual logic. This order saved
  the most time historically; keep using it.

---

## 5. Rejected/evaluated approaches (so they aren't re-litigated)

- **Google Drive as image/photo storage for inventory items** — rejected. No
  fast thumbnail API, rate limits under repeated small requests, no on-the-fly
  resizing. Supabase Storage (built-in image transforms, direct URLs, ties to
  RLS) was chosen instead.
- **Pure OCR (Tesseract.js, Google Cloud Vision, OCR.space) as the primary way
  to read expiry dates/manufacturer off packaging** — evaluated, but raw OCR
  only extracts text, it doesn't understand *what* the text means, and
  struggles with curved/embossed real-world packaging. AI vision (the existing
  Claude Bill Scanner pattern) does semantic extraction and was recommended as
  the primary approach, with Tesseract.js only as a free first-pass fallback
  for flat printed text.
- **Native Google ML Kit on-device OCR** — not usable; it's native-app-only,
  not available to a web PWA without wrapping in something like Capacitor.

---

## 6. Immediate next step for this chat

Didula is moving to **Claude Cowork** to design/refine the architecture further
before handing it to **Claude Code** for implementation. Suggested use of this
session:
1. Confirm/attach the full `SYSTEM_ARCHITECTURE.md` spec (schema, scanning
   design, phased plan) referenced in §3.
2. Resolve the four open decisions listed in §3.
3. Produce whatever Claude Code needs as a clean, final build brief —
   likely the architecture doc plus this handover, or a merged single
   document — before starting Phase 0 (Supabase project + schema + Auth +
   PWA shell).
