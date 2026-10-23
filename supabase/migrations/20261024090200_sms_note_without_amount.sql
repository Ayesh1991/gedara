-- Phase 9 · 87 — a note may have no amount (9b.1 fix).
--
-- Star Points' "you have earned … for your transaction at Cargills Rewards on 2026/10/20 21:10:25" names
-- a shop and a time but no amount: it is a note (kind `info`) that points at the card charge it explains.
-- Since Phase 2b only `unknown` alerts could have no amount, so such a note was refused — and with it the
-- whole import batch it was in. Money kinds still must have an amount.

alter table public.sms_message drop constraint sms_message_check;
alter table public.sms_message add constraint sms_message_amount_needed_check
  check (kind in ('unknown', 'info') or amount is not null);

update public.app_meta set value = '87' where key = 'schema_version';
