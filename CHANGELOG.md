# Changelog

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
