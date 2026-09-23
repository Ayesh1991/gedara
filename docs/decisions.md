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
