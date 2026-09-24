# Changelog

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
