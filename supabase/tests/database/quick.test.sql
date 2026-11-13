-- Phase 12 (migrations 111–112): Quick spend.
-- * setup gives each person a wallet + starter tiles on our real categories, once
-- * an entry id is counted once: the same op again, in a batch, out of order, from "two phones"
-- * two genuine identical entries are two (~2), a bad op is refused alone, the batch goes on
-- * entries are ordinary expenses through the money RPCs (balance = sum of transactions; Vendor is
--   spending, not pantry stock); a deleted entry is not brought back by a late resend
-- * viewers can't add; another household can't read or write tiles, settings or the entry log
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c1101', 'quick-owner@test.local'),
  ('00000000-0000-0000-0000-0000000c1102', 'quick-member@test.local'),
  ('00000000-0000-0000-0000-0000000c1103', 'quick-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000c1201', 'quick-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000c11aa', 'Quick A'),
  ('00000000-0000-0000-0000-0000000c12bb', 'Quick B');
insert into household_member (household_id, user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000c11aa', '00000000-0000-0000-0000-0000000c1101', 'owner', 'Didula Test'),
  ('00000000-0000-0000-0000-0000000c11aa', '00000000-0000-0000-0000-0000000c1102', 'member', 'Sandeepani Test'),
  ('00000000-0000-0000-0000-0000000c11aa', '00000000-0000-0000-0000-0000000c1103', 'viewer', 'Viewer'),
  ('00000000-0000-0000-0000-0000000c12bb', '00000000-0000-0000-0000-0000000c1201', 'owner', 'Other');
select private.seed_categories('00000000-0000-0000-0000-0000000c11aa');
select private.seed_categories('00000000-0000-0000-0000-0000000c12bb');
insert into account (id, household_id, name, kind, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000c11a1', '00000000-0000-0000-0000-0000000c11aa', 'Cash', 'cash', 5000, '2026-01-01'),
  ('00000000-0000-0000-0000-0000000c12b1', '00000000-0000-0000-0000-0000000c12bb', 'Cash', 'cash', 0, '2026-01-01');

set local role authenticated;

-- ── Setup ─────────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000c1101","role":"authenticated"}';
select is(rpc_quick_setup('00000000-0000-0000-0000-0000000c11aa') ->> 'tiles_created', '14', 'first open: starter tiles');
select is((select name from account where id = '00000000-0000-0000-0000-0000000c11a1'), 'Cash — Didula',
  'the owner keeps the existing Cash (history kept), now named as theirs');
select is((select cash_account_id from quick_prefs where user_id = '00000000-0000-0000-0000-0000000c1101'),
  '00000000-0000-0000-0000-0000000c11a1'::uuid, 'and pays from it');
select is((select (r ->> 'wallet_created') || ' ' || (r ->> 'tiles_created') from rpc_quick_setup('00000000-0000-0000-0000-0000000c11aa') r),
  'false 0', 'setup again changes nothing');
select is((select c.name || ' < ' || p.key from quick_tile t join category c on c.id = t.category_id join category p on p.id = c.parent_id
            where t.key = 'tuk' and t.user_id = '00000000-0000-0000-0000-0000000c1101'),
  'Taxi / PickMe / Uber < transport', 'Three-wheeler sits on our real category');
select is((select count(*)::int from quick_tile where user_id = '00000000-0000-0000-0000-0000000c1101' and not hidden), 9, 'nine tiles shown to start');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000c1102","role":"authenticated"}';
select is(rpc_quick_setup('00000000-0000-0000-0000-0000000c11aa') ->> 'wallet_created', 'true', 'the member gets a wallet of her own');
select is((select a.name from quick_prefs q join account a on a.id = q.cash_account_id where q.user_id = '00000000-0000-0000-0000-0000000c1102'),
  'Cash — Sandeepani', 'named as hers');
select lives_ok($$update quick_tile set label = 'Mine now' where user_id = '00000000-0000-0000-0000-0000000c1101'$$,
  'her update of his tiles touches no row');
select is((select count(*)::int from quick_tile where label = 'Mine now'), 0, 'his tiles are untouched');

-- ── One entry, counted once ───────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000c1101","role":"authenticated"}';
create temp table t_r (k text primary key, v jsonb) on commit drop;
grant all on t_r to public;
insert into t_r values ('tea', rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-0000-0000-00000000a001', 'label', 'Tea', 'amount', 100, 'client_at', now() - interval '2 hours',
  'tile_id', (select id from quick_tile where key = 'tea' and user_id = '00000000-0000-0000-0000-0000000c1101'),
  'category_id', (select category_id from quick_tile where key = 'tea' and user_id = '00000000-0000-0000-0000-0000000c1101'),
  'fingerprint', 'mtea1', 'line_tail', 'abc'))));
select is((select v -> 0 ->> 'status' from t_r where k = 'tea'), 'saved', 'Tea 100 saved');
select is((select t.type || ' ' || t.total || ' ' || t.source || ' ' || a.name || ' ' || (t.created_by = '00000000-0000-0000-0000-0000000c1101')::text
             from money_transaction t join account a on a.id = t.account_id where t.fingerprint = 'mtea1'),
  'expense 100.00 manual Cash — Didula true', 'an ordinary expense, from his wallet, by him');
select is((select l.raw_name || ' ' || l.destiny || ' ' || l.fingerprint from transaction_line l
            join money_transaction t on t.id = l.transaction_id where t.fingerprint = 'mtea1'),
  'Tea expense mtea1-0-abc', 'one line, plain spending, deterministic line fingerprint');
select is(rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', '[{"op_id":"00000000-0000-0000-0000-00000000a001","label":"Tea","amount":100,"client_at":"2026-11-12T03:00:00Z","fingerprint":"mtea1","line_tail":"abc"}]'::jsonb)
  -> 0 ->> 'status', 'replayed', 'the same op again is a replay');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000c11aa'), 1, 'and still one transaction');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000c11a1'), 4900.00, 'the balance is opening − the entry');

-- ── A batch: a replay, a new one, a bad one, a twin, out of order ──────────────
insert into t_r values ('batch', rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', '[
  {"op_id":"00000000-0000-0000-0000-00000000a003","label":"Bus","amount":60,"client_at":"2026-11-10T09:00:00Z","fingerprint":"mbus3","line_tail":"x"},
  {"op_id":"00000000-0000-0000-0000-00000000a001","label":"Tea","amount":100,"client_at":"2026-11-12T03:00:00Z","fingerprint":"mtea1","line_tail":"abc"},
  {"op_id":"00000000-0000-0000-0000-00000000a004","label":"Typo","amount":999999,"client_at":"2026-11-10T09:01:00Z","fingerprint":"mtypo","line_tail":"x"},
  {"op_id":"00000000-0000-0000-0000-00000000a002","label":"Bus","amount":60,"client_at":"2026-11-10T08:00:00Z","fingerprint":"mbus3","line_tail":"x"},
  {"op_id":"00000000-0000-0000-0000-00000000a005","label":"Vendor","amount":250,"client_at":"2099-01-01T00:00:00Z","fingerprint":"mven5","line_tail":"v",
   "category_id":null}
  ]'::jsonb));
select is((select string_agg(e ->> 'status', ',' order by o) from t_r, jsonb_array_elements(v) with ordinality x(e, o) where k = 'batch'),
  'saved,replayed,refused,saved,saved', 'each op answers for itself, in the order sent');
select is((select v -> 2 ->> 'code' from t_r where k = 'batch'), 'GDQAM', 'the typo is refused by the hard stop');
select is((select v -> 3 ->> 'fingerprint' from t_r where k = 'batch'), 'mbus3~2', 'a genuine twin gets ~2, not dropped');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000c11aa'), 4, 'four entries in all');
select is((select occurred_on <= (now() at time zone 'Asia/Colombo')::date from money_transaction where fingerprint = 'mven5'), true,
  'a tap "in the future" (wrong phone clock) is saved as now');
select is((select occurred_on::text || ' ' || occurred_at::text from money_transaction where fingerprint = 'mbus3'), '2026-11-10 14:30:00',
  'an entry that waited keeps the time it was tapped (Colombo)');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-0000000c11a1'), 4530.00,
  'balance = opening − (100 + 60 + 60 + 250)');

-- ── Deleted, then resent late: not brought back ───────────────────────────────
select lives_ok($$select rpc_delete_transaction((select id from money_transaction where fingerprint = 'mven5'))$$, 'Undo deletes through the money RPC');
select is(rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', '[{"op_id":"00000000-0000-0000-0000-00000000a005","label":"Vendor","amount":250,"client_at":"2026-11-10T09:00:00Z","fingerprint":"mven5","line_tail":"v"}]'::jsonb)
  -> 0 ->> 'status', 'replayed', 'a late resend of the deleted entry is a replay');
select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000c11aa'), 3, 'and it stays deleted');

-- ── Hand-over: cash to the other wallet is a transfer, not spending ───────────
select is(rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-0000-0000-00000000a006', 'kind', 'handover', 'label', 'Gave cash', 'amount', 1000, 'client_at', now(),
  'to_account_id', (select cash_account_id from quick_prefs where user_id = '00000000-0000-0000-0000-0000000c1102'),
  'fingerprint', 'mgave6'))) -> 0 ->> 'status', 'saved', 'Gave cash 1,000');
select is((select balance from v_account_balance v join quick_prefs q on q.cash_account_id = v.account_id
            where q.user_id = '00000000-0000-0000-0000-0000000c1102'), 1000.00, 'her wallet has it');

-- ── The screen's one read ─────────────────────────────────────────────────────
select is((select jsonb_array_length(s -> 'tiles') || ' tiles, ' || jsonb_array_length(s -> 'entries') || ' entries, balance ' || (s ->> 'balance')
             || ', other wallet ' || (s -> 'wallets' -> 0 ->> 'person') from rpc_quick_state('00000000-0000-0000-0000-0000000c11aa') s),
  '14 tiles, 5 entries, balance 3780.00, other wallet Sandeepani', 'one read: tiles, my entries, my balance, her wallet');
select is((select count(*)::int from jsonb_array_elements(rpc_quick_state('00000000-0000-0000-0000-0000000c11aa') -> 'entries') e where e ->> 'id' is null),
  1, 'the deleted entry is listed without a transaction');
select is((rpc_quick_state('00000000-0000-0000-0000-0000000c11aa') ->> 'since_check')::int, 4, 'four entries from my wallet since the last cash check');

-- ── Direct writes, viewers, the other household ───────────────────────────────
select throws_ok($$insert into quick_entry (household_id, op_id, amount, client_at)
  values ('00000000-0000-0000-0000-0000000c11aa', gen_random_uuid(), 1, now())$$, '42501', null, 'the entry log is written by rpc_quick_spend only');
select throws_ok($$insert into quick_prefs (household_id) values ('00000000-0000-0000-0000-0000000c11aa')$$, '42501', null,
  'settings are created by rpc_quick_setup only');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000c1103","role":"authenticated"}';
select throws_ok($$select rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', '[{"op_id":"00000000-0000-0000-0000-00000000a0f1","label":"Tea","amount":100,"client_at":"2026-11-12T03:00:00Z","fingerprint":"mview","line_tail":"x"}]'::jsonb)$$,
  '42501', null, 'a viewer can''t add');
select throws_ok($$select rpc_quick_setup('00000000-0000-0000-0000-0000000c11aa')$$, '42501', null, 'nor set up');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000c1201","role":"authenticated"}';
select is((select count(*)::int from quick_tile) + (select count(*)::int from quick_prefs) + (select count(*)::int from quick_entry), 0,
  'household B sees none of A''s tiles, settings or entries');
select is(rpc_quick_state('00000000-0000-0000-0000-0000000c11aa'), null, 'B reads nothing of A''s Quick spend');
select throws_ok($$select rpc_quick_spend('00000000-0000-0000-0000-0000000c11aa', '[{"op_id":"00000000-0000-0000-0000-00000000a0f2","label":"Tea","amount":100,"client_at":"2026-11-12T03:00:00Z","fingerprint":"mother","line_tail":"x"}]'::jsonb)$$,
  '42501', null, 'B can''t add to A');
select throws_ok($$insert into quick_tile (household_id, label) values ('00000000-0000-0000-0000-0000000c11aa', 'Sneaky')$$,
  '42501', null, 'B can''t add a tile to A');

select * from finish();
rollback;
