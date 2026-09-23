# Gedara (ගෙදර) — household ledger + pantry + assets PWA

Solo project for one household in Sri Lanka (LKR, Asia/Colombo). Built phase by phase.

## Fixed facts
- Users (invite-only, email OTP): Didula Ayeshmantha `ayeshmantha@gmail.com` (owner), Sandeepani Thennakoon `asithaathennakoon@gmail.com` (member). Public sign-up disabled.
- Supabase: separate account `ayeshmantha1991.24@gmail.com`; projects `gedara-staging`, `gedara-prod` (Singapore).
- Hosting: Vercel `gedara.vercel.app` (no custom domain). URL QR codes use `/s/<code>`.
- Codes: `HL:LOC|PRD|AST|LOT:<6-char Crockford base32, UPPERCASE>`.
- Labels: NIIMBOT B1 20×20 mm (raw code only, QR version 1-M, 203 dpi 1-bit, 1 text line ≤10 chars); Epson L3110 A4 6 rows × 9 cols = 54 (URL QR, configurable grid + calibration offsets).

## Read first
- `docs/MASTER_PLAN.md` is the source of truth (schema §3, phases §9, handoff §11).
- `docs/HANDOVER.md` covers history and lessons. `docs/archive/*` is superseded; don't implement from it.
- `reference/` holds read-only inputs (ledger v7, bill-scanner samples, exports). Never edit or ship it.
- Work only on the phase you were asked for. Start in plan mode and get approval before coding.

## Stack
Vite + React + TS (strict) + Tailwind + shadcn/ui · TanStack Router/Query · supabase-js v2 ·
Supabase (Postgres, Auth email-OTP, Storage, Realtime, Edge Functions/Deno, pg_cron) ·
vite-plugin-pwa (NetworkFirst) · Vercel · Vitest + Playwright · Python 3 for `devices/pi-station`.

## Commands
- `pnpm dev` · `pnpm test` · `pnpm e2e` · `pnpm typecheck` · `pnpm lint`
- `supabase db reset` (local) · `supabase migration new <name>` · `supabase gen types typescript --local > apps/web/src/lib/db.types.ts`
- Run typecheck + tests before saying a task is done.

## Non-negotiable rules
1. Stock and balances are never edited directly. Only `stock_movement` rows written through the SECURITY DEFINER RPCs (`rpc_purchase`, `rpc_consume`, `rpc_weigh`, `rpc_undo` …).
2. Every table has `household_id`, RLS enabled (`private.is_member(household_id)` for reads, `private.can_write(household_id)` for writes), and a SQL test showing another household can't read or write it.
3. Migrations are forward-only. Never edit a migration that has already been applied. Staging first, prod only via migration files.
4. Money is `numeric(14,2)` and quantities `numeric(14,4)`. Format with `Intl.NumberFormat('en-LK',{style:'currency',currency:'LKR'})`. Prices are also stored per base unit (`price_per_base`).
5. Fingerprints are deterministic (djb2, same format as `reference/ledger-v7`: `b<hash>` for bills, `b<hash>-<lineNo>-<hash>` for lines) and unique per household. Never replace them with random IDs.
6. Validate all external JSON (bill scanner, Open Food Facts, Drive, device payloads) with Zod. Check MIME types and don't trust file extensions.
7. The service worker is NetworkFirst. Bump `APP_VERSION` on every deploy and show it plus the git SHA and DB `schema_version` in the footer and on the Diagnostics page.
8. Never put the service-role key or any Google/Claude API key in `apps/web`. Secrets live only in Edge Functions and `.env.local` (git-ignored).
9. Compress photos in the browser (WebP 1600 px + 320 px thumb) before upload. Don't use Supabase image transforms.
10. Mobile-first: one-thumb reach, test at 375 px and iPad widths. Respect `prefers-reduced-motion`.
11. Design language is "Aurora" (approved 2026-09-23; tokens in `apps/web/src/styles/index.css`): void `#05070F`, glass panels, Space Grotesk + IBM Plex Mono (every number). User-selectable aurora themes (aurora/nebula/lagoon/ember/mono) change only the aurora light and accents; gold `#F5B83D` is the single primary action per screen and status colours (red unsafe, amber best-before, cyan due, violet info, teal good) never change. Never show fake numbers in the app: empty states until real data exists.
12. All UI strings go through i18n (`en` now, `si` later).
13. "Done" means deployed to a Vercel preview and the version badge on that URL matches. Say so explicitly.

## Debug order (cheapest first)
Version badge → correct deploy? → Edge Function version → service worker cache → then the logic.

## Tools
- Supabase MCP: staging project only. Prod is read-only or not connected.
- Use Context7 for current library docs (Supabase, TanStack, vite-plugin-pwa) instead of guessing APIs.
- Use Playwright MCP to check UI flows in a real browser before reporting a UI task done.

## Log
Append decisions to `docs/decisions.md` (date · decision · why).
