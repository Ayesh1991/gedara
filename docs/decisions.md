# Decisions log

Format: date · decision · why. Append-only.

- 2026-09-23 · Project name **Gedara (ගෙදර)**; slug `gedara` everywhere · final name
- 2026-09-23 · Backend Supabase on a **separate account (ayeshmantha1991.24@gmail.com)**, projects `gedara-staging` + `gedara-prod`, region Singapore · main account is used by another project; closest region
- 2026-09-23 · Hosting Vercel on `gedara.vercel.app` (fallback `gedara-home`), **no custom domain** · free; QR plan in MASTER_PLAN §7d
- 2026-09-23 · Household model; users Didula Ayeshmantha (ayeshmantha@gmail.com, owner) and Sandeepani Thennakoon (asithaathennakoon@gmail.com, member); public sign-up disabled · two-person household with invite-only access
- 2026-09-23 · Auth = email 6-digit OTP (not magic link) · magic links open Safari, not the installed iOS PWA
- 2026-09-23 · Labels: NIIMBOT B1 **20×20 mm** (raw code only, QR v1-M alphanumeric) + Epson L3110 A4 **6×9 = 54** (URL QR) · owned/purchased hardware
- 2026-09-23 · Photos: Supabase thumbnails + full size until ~70 % full; Google Drive overflow for large files/docs · stay within free tiers
- 2026-09-23 · Kitchen Scale Station on Raspberry Pi 2 (HX711 5 kg + USB scanner + NIIMBOT print service) as Phase 6b · exact consumption of loose goods
- 2026-09-23 · Auth emails sent via **Gmail SMTP** (ayeshmantha1991.24@gmail.com, App Password) in both projects · Supabase default SMTP only reaches org team members, 2/hour
- 2026-09-23 · Vercel Root Directory = `apps/web` · never publish docs/reference as static files
- 2026-09-23 · React 19 / Vite 8 / Tailwind 4 / TypeScript 6.0 instead of MASTER_PLAN's "React 18" · current shadcn/ui + TanStack target React 19; TS pinned < 6.1 because typescript-eslint doesn't support TS 7 yet
- 2026-09-23 · `app_meta` is the one table without `household_id` (RLS on, no policies, read only via `schema_version()`) · global build metadata, nothing household-specific
- 2026-09-23 · `schema_version` = integer bumped by the last statement of every migration · the badge shows exactly which migration a DB has
- 2026-09-23 · Service worker via vite-plugin-pwa **injectManifest** (own `src/sw.ts`), not generateSW · generateSW's precache is cache-first; ours is network-first with caches as offline fallback only
- 2026-09-23 · APP_VERSION = `apps/web/package.json` version, scheme `0.<phase>.<deploy>` · version tells you the phase at a glance
- 2026-09-23 · Tenancy tables are read-only to clients in Phase 0; membership only via `household_invite` + auth trigger · invite-only household
- 2026-09-23 · No Docker: SQL tests run against gedara-staging via `scripts/sql-test.mjs` → `supabase db query --linked` (Management API; each test ends by raising its TAP output, so the transaction always aborts — nothing persists; refuses unless linked ref = staging; `--with-migrations` proves new migrations before `db push`); e2e logs in with an admin-minted OTP (`generateLink`, no email) and refuses non-staging URLs · develop against staging, never prod
- 2026-09-23 · supabase-js pinned to 2.116.0 (not 2.117.1) · pnpm 12 minimum-release-age gate; don't bypass it for day-old releases
- 2026-09-23 · RLS helpers live in schema `private` (`private.is_member`, `private.can_write`, `private.is_owner`), moved there by migration 6 · Supabase advisor 0029: SECURITY DEFINER helpers shouldn't be callable as /rest/v1/rpc; cheaper to fix before dozens of policies exist
- 2026-09-23 · Accepted advisor warnings: `schema_version()` executable by anon/authenticated (intentional — badge shows DB version on the login screen) · leaked-password protection off (OTP-only, no passwords)
- 2026-09-23 · gedara-staging was created in **Tokyo (ap-northeast-1)**, prod is Singapore · staging-only latency cost; not worth recreating now
