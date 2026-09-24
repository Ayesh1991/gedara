-- Transactions + lines: read-only tables, all writes through the RPCs; fingerprint dedupe,
-- lines must add up, transfer fees, computed balances, household isolation, viewer read-only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f7101', 'tx-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000f7103', 'tx-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000f8101', 'tx-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000f17aa', 'Tx A'),
  ('00000000-0000-0000-0000-0000000f18bb', 'Tx B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000f17aa', '00000000-0000-0000-0000-0000000f7101', 'owner'),
  ('00000000-0000-0000-0000-0000000f17aa', '00000000-0000-0000-0000-0000000f7103', 'viewer'),
  ('00000000-0000-0000-0000-0000000f18bb', '00000000-0000-0000-0000-0000000f8101', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000f17aa', 'grocery', 'Grocery', 'stock'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000f17aa', 'services', 'Services', 'expense'),
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f18bb', 'grocery', 'Grocery', 'stock');
insert into account (id, household_id, name, kind, opening_balance, opening_on, credit_limit) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000f17aa', 'Cash', 'cash', 1000, '2026-09-01', null),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000f17aa', 'BOC', 'bank', 20000, '2026-09-01', null),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-0000000f17aa', 'Card', 'credit_card', -8000, '2026-09-01', 100000),
  ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-0000000f18bb', 'Cash', 'cash', 0, null, null);

set local role authenticated;

-- ── Owner of A ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7101","role":"authenticated"}';

select lives_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000b001","payee_text":"Sahana  Vegemart",
  "occurred_on":"2026-09-10","occurred_at":"19:42","total":500,"fingerprint":"mtest1",
  "lines":[{"raw_name":"Carrot","category_id":"00000000-0000-0000-0000-00000000e001",
            "qty":2,"unit_text":"Kg","amount":500,"fingerprint":"mtest1-0-abc"}]}'::jsonb)$$,
  'owner saves a cash expense');
select is((select b.code || ' ' || l.base_qty || ' ' || l.price_per_base || ' ' || l.destiny
             from transaction_line l join unit b on b.id = l.unit_id where l.fingerprint = 'mtest1-0-abc'),
  'kg 2000.0000 0.2500 stock', 'line unit normalised to Rs per gram; destiny from the category');
select is((select m.name from money_transaction t join merchant m on m.id = t.merchant_id where t.fingerprint = 'mtest1'),
  'Sahana Vegemart', 'the payee became a merchant');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000b001","occurred_on":"2026-09-10","total":500,"fingerprint":"mtest1",
  "lines":[{"raw_name":"Carrot","amount":500,"fingerprint":"mtest1-0-abc"}]}'::jsonb)$$,
  'GDDUP', null, 'the same fingerprint is refused with GDDUP');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000b001","occurred_on":"2026-09-10","total":600,"fingerprint":"mtest2",
  "lines":[{"raw_name":"Beans","amount":500,"fingerprint":"mtest2-0-abc"}]}'::jsonb)$$,
  '23514', null, 'lines must add up to the total');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000b001","occurred_on":"2026-09-10","total":500,"fingerprint":"mtest3",
  "lines":[{"raw_name":"Beans","amount":500,"fingerprint":"zzz-0-abc"}]}'::jsonb)$$,
  '23514', null, 'line fingerprints must extend the header''s');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense","occurred_on":"2026-09-10","total":500,
  "account_id":"00000000-0000-0000-0000-00000000b101","fingerprint":"mtest4",
  "lines":[{"raw_name":"Beans","amount":500,"fingerprint":"mtest4-0-abc"}]}'::jsonb)$$,
  '23503', null, 'another household''s account is rejected');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense","occurred_on":"2026-09-10","total":500,
  "account_id":"00000000-0000-0000-0000-00000000b001","fingerprint":"mtest5",
  "lines":[{"raw_name":"Beans","amount":500,"category_id":"00000000-0000-0000-0000-00000000e101","fingerprint":"mtest5-0-abc"}]}'::jsonb)$$,
  '23503', null, 'another household''s category is rejected');

select lives_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"transfer",
  "account_id":"00000000-0000-0000-0000-00000000b002","to_account_id":"00000000-0000-0000-0000-00000000b003",
  "occurred_on":"2026-09-12","total":5000,"fingerprint":"mtest6","lines":[],
  "fee":{"amount":25,"category_id":"00000000-0000-0000-0000-00000000e002"}}'::jsonb)$$,
  'owner pays the card from BOC with a Rs 25 fee');
select is((select count(*)::int from money_transaction f join money_transaction t on t.id = f.related_id
            where t.fingerprint = 'mtest6' and f.type = 'expense' and f.total = 25), 1, 'the fee is its own linked expense');
select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"transfer","occurred_on":"2026-09-12","total":5,
  "account_id":"00000000-0000-0000-0000-00000000b002","to_account_id":"00000000-0000-0000-0000-00000000b002",
  "fingerprint":"mtest7","lines":[]}'::jsonb)$$,
  '23514', null, 'a transfer needs two different accounts');

-- Before Cash's opening day: counts as spending, not towards the balance.
select lives_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"expense",
  "account_id":"00000000-0000-0000-0000-00000000b001","occurred_on":"2026-08-20","total":300,"fingerprint":"mtest8",
  "lines":[{"raw_name":"Old bill","amount":300,"fingerprint":"mtest8-0-x"}]}'::jsonb)$$,
  'history before the opening day can be recorded');

select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-00000000b001'), 500.00,
  'cash: 1000 opening − 500 (the older 300 is before opening)');
select is((select balance from v_account_balance where account_id = '00000000-0000-0000-0000-00000000b002'), 14975.00,
  'BOC: 20000 − 5000 − 25 fee');
select is((select balance || ' / ' || available from v_account_balance where account_id = '00000000-0000-0000-0000-00000000b003'),
  '-3000.00 / 97000.00', 'card: owed 8000 − 5000 paid; available = limit + balance');
select is((select spent from v_monthly_cashflow where household_id = '00000000-0000-0000-0000-0000000f17aa' and month = '2026-09-01'),
  525.00, 'September spending = 500 + 25 fee (transfers excluded)');

-- Imports: idempotent by bill and by line fingerprint.
select is((select jsonb_agg(x ->> 'status') from jsonb_array_elements(rpc_import_bills('00000000-0000-0000-0000-0000000f17aa', '[
  {"account_id":"00000000-0000-0000-0000-00000000b003","payee_text":"CARGILLS FOOD CITY","occurred_on":"2026-08-22",
   "occurred_at":"20:20","invoice_no":"265","total":580,"source":"scan","fingerprint":"b1ob3kse",
   "lines":[{"line_no":0,"raw_name":"Bic Twin Lady Razor","amount":320,"fingerprint":"b1ob3kse-0-aaa"},
            {"line_no":1,"raw_name":"Anchor Hot Chocolate","amount":260,"fingerprint":"b1ob3kse-1-bbb"}]},
  {"account_id":"00000000-0000-0000-0000-00000000b001","payee_text":"Cargills  food city","occurred_on":"2026-06-27",
   "total":335,"source":"import_sheet","fingerprint":"Labc123",
   "lines":[{"line_no":0,"raw_name":"Garbage Bag","amount":335,"fingerprint":"mr3du3xnbr8jn"}]}]'::jsonb)) x),
  '["imported", "imported"]'::jsonb, 'two bills imported');
select is((select jsonb_agg(x ->> 'status') from jsonb_array_elements(rpc_import_bills('00000000-0000-0000-0000-0000000f17aa', '[
  {"account_id":"00000000-0000-0000-0000-00000000b003","payee_text":"CARGILLS FOOD CITY","occurred_on":"2026-08-22",
   "total":580,"source":"scan","fingerprint":"b1ob3kse",
   "lines":[{"line_no":0,"raw_name":"Bic Twin Lady Razor","amount":320,"fingerprint":"b1ob3kse-0-aaa"},
            {"line_no":1,"raw_name":"Anchor Hot Chocolate","amount":260,"fingerprint":"b1ob3kse-1-bbb"}]},
  {"account_id":"00000000-0000-0000-0000-00000000b001","payee_text":"Cargills","occurred_on":"2026-06-27",
   "total":335,"source":"import_sheet","fingerprint":"Lother",
   "lines":[{"line_no":0,"raw_name":"Garbage Bag","amount":335,"fingerprint":"mr3du3xnbr8jn"}]}]'::jsonb)) x),
  '["duplicate", "duplicate"]'::jsonb, 're-importing the same bills (or the same Sheet rows) changes nothing');
select is((select count(*)::int from merchant where household_id = '00000000-0000-0000-0000-0000000f17aa'), 2,
  'both spellings of Cargills resolved to one merchant');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000f17aa', '[
  {"account_id":"00000000-0000-0000-0000-00000000b001","occurred_on":"2026-08-01","total":99,"source":"scan",
   "fingerprint":"bbad","lines":[{"line_no":0,"raw_name":"x","amount":98,"fingerprint":"bbad-0-x"}]}]'::jsonb)$$,
  '23514', null, 'an imported bill must add up too');

-- Clients can't write the tables directly.
select throws_ok($$insert into money_transaction (household_id, type, account_id, occurred_on, total, fingerprint)
  values ('00000000-0000-0000-0000-0000000f17aa', 'income', '00000000-0000-0000-0000-00000000b001', '2026-09-10', 1, 'mdirect')$$,
  '42501', null, 'no direct inserts');
select throws_ok($$update money_transaction set total = 1 where fingerprint = 'mtest1'$$,
  '42501', null, 'no direct updates');
select throws_ok($$delete from transaction_line where fingerprint = 'mtest1-0-abc'$$,
  '42501', null, 'no direct deletes');

-- Moving card rows; deleting a transfer takes its fee along.
select is(rpc_move_transactions(array[(select id from money_transaction where fingerprint = 'mtest1')],
  '00000000-0000-0000-0000-00000000b003'), 1, 'an expense can be moved to another account');
select throws_ok($$select rpc_move_transactions(array[(select id from money_transaction where fingerprint = 'mtest6')],
  '00000000-0000-0000-0000-00000000b001')$$, '42501', null, 'transfers are not moved in bulk');
select lives_ok($$select rpc_delete_transaction((select id from money_transaction where fingerprint = 'mtest6'))$$,
  'owner deletes the transfer');
select is((select count(*)::int from money_transaction where fingerprint like 'mtest6%'), 0, 'its fee went with it');

-- ── Owner of B ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f8101","role":"authenticated"}';

select is((select count(*)::int from money_transaction where household_id = '00000000-0000-0000-0000-0000000f17aa')
        + (select count(*)::int from transaction_line where household_id = '00000000-0000-0000-0000-0000000f17aa')
        + (select count(*)::int from v_account_balance where household_id = '00000000-0000-0000-0000-0000000f17aa'), 0,
  'B sees none of A''s transactions, lines or balances');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000f17aa', '[]'::jsonb)$$,
  '42501', null, 'B cannot import into A');
select throws_ok($$select rpc_delete_transaction((select id from money_transaction where fingerprint = 'b1ob3kse'))$$,
  '42501', null, 'B cannot delete A''s transactions (not even by guessing)');

-- ── Viewer of A ───────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000f7103","role":"authenticated"}';

select throws_ok($$select rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000f17aa","type":"income","occurred_on":"2026-09-10","total":1,
  "account_id":"00000000-0000-0000-0000-00000000b001","fingerprint":"mviewer",
  "lines":[{"raw_name":"x","amount":1,"fingerprint":"mviewer-0-x"}]}'::jsonb)$$,
  '42501', null, 'viewer cannot save transactions');

-- ── Anonymous ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from money_transaction$$, '42501', null, 'anon cannot read transactions');

select * from finish();
rollback;
