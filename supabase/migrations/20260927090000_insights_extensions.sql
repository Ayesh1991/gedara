-- Phase 6 · 40 — extensions for Insights & Attention
--   pg_trgm  fuzzy ⌘K search over names (MASTER_PLAN §3.7 search_index)
--   pg_net   the daily job calls the attention-push Edge Function over HTTP
--   pg_cron  the daily 07:00 Asia/Colombo job (§4 row 7)
-- Supabase puts pg_trgm / pg_net in `extensions` (not exposed as the API) and pg_cron in pg_catalog.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

update public.app_meta set value = '40' where key = 'schema_version';
