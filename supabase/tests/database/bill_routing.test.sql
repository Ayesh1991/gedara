-- Bill routing (Phase 4 "the spine"): one import = expense + lots + ticked list items; unit
-- conversion and normalised cost on lots, default and explicit due dates / places, learned names,
-- duplicates route nothing, cross-household ids rejected, routing an existing bill, routed lines
-- locked on edit, deleting a bill takes its untouched stock back (or refuses / keeps it), prices by
-- shop, the invariant qty_remaining = Σ delta.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
-- JSON with PACK / G / PCS / KG placeholders → unit ids, TODAY → the current date.
create function pg_temp.j(p text) returns jsonb language sql stable as
  $$ select replace(replace(replace(replace(replace(p, '"PACK"', to_json(pg_temp.u('pack')::text)::text),
                                   '"G"', to_json(pg_temp.u('g')::text)::text),
                           '"PCS"', to_json(pg_temp.u('pcs')::text)::text),
                   '"KG"', to_json(pg_temp.u('kg')::text)::text),
           '"TODAY"', to_json(current_date::text)::text)::jsonb $$;
create function pg_temp.line(p_fp text) returns uuid language sql stable as
  $$ select id from public.transaction_line where fingerprint = p_fp $$;
create function pg_temp.lot(p_fp text) returns public.stock_lot language sql stable as
  $$ select k.* from public.stock_lot k join public.transaction_line l on l.id = k.transaction_line_id
      where l.fingerprint = p_fp and k.split_from_id is null $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000fb101', 'route-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000fb103', 'route-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000fb201', 'route-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000fb1aa', 'Route A'),
  ('00000000-0000-0000-0000-0000000fb2bb', 'Route B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-0000000fb101', 'owner'),
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-0000000fb103', 'viewer'),
  ('00000000-0000-0000-0000-0000000fb2bb', '00000000-0000-0000-0000-0000000fb201', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-0000000fb1aa', 'grocery', 'Grocery', 'stock'),
  ('00000000-0000-0000-0000-00000000eb03', '00000000-0000-0000-0000-0000000fb1aa', 'nonconsumable', 'Non-consumables', 'asset');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000fb1aa', 'Cash', 'cash'),
  ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-0000000fb1aa', 'Card', 'credit_card');
insert into location (id, household_id, name, climate) values
  ('00000000-0000-0000-0000-00000000cb01', '00000000-0000-0000-0000-0000000fb1aa', 'Pantry', 'ambient'),
  ('00000000-0000-0000-0000-00000000cb02', '00000000-0000-0000-0000-0000000fb1aa', 'Fridge', 'fridge'),
  ('00000000-0000-0000-0000-00000000cbb1', '00000000-0000-0000-0000-0000000fb2bb', 'Pantry B', 'ambient');
insert into product (id, household_id, name, stock_unit_id, purchase_unit_id, default_location_id, due_type, default_due_days) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-0000000fb1aa', 'Sugar', pg_temp.u('g'), pg_temp.u('pack'),
   '00000000-0000-0000-0000-00000000cb01', 'best_before', 180),
  ('00000000-0000-0000-0000-00000000db02', '00000000-0000-0000-0000-0000000fb1aa', 'Eggs', pg_temp.u('pcs'), pg_temp.u('pack'),
   null, 'none', null),
  ('00000000-0000-0000-0000-00000000db03', '00000000-0000-0000-0000-0000000fb1aa', 'Hot chocolate', pg_temp.u('g'), null,
   '00000000-0000-0000-0000-00000000cb01', 'best_before', 365),
  ('00000000-0000-0000-0000-00000000db04', '00000000-0000-0000-0000-0000000fb1aa', 'Salt', pg_temp.u('g'), null,
   null, 'none', null),
  ('00000000-0000-0000-0000-00000000dbb1', '00000000-0000-0000-0000-0000000fb2bb', 'Rice B', pg_temp.u('g'), null,
   null, 'none', null);
insert into product_unit_conversion (household_id, product_id, from_unit_id, to_unit_id, factor) values
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-00000000db01', pg_temp.u('pack'), pg_temp.u('g'), 400),
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-00000000db02', pg_temp.u('pack'), pg_temp.u('pcs'), 10);
insert into shopping_list_item (id, household_id, product_id, free_text) values
  ('00000000-0000-0000-0000-00000000bc01', '00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-00000000db01', null),
  ('00000000-0000-0000-0000-00000000bc02', '00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-00000000db02', null),
  ('00000000-0000-0000-0000-00000000bc03', '00000000-0000-0000-0000-0000000fb1aa', null, 'Candles'),
  ('00000000-0000-0000-0000-00000000bc04', '00000000-0000-0000-0000-0000000fb1aa', null, 'Not bought'),
  ('00000000-0000-0000-0000-00000000bcb1', '00000000-0000-0000-0000-0000000fb2bb', null, 'B''s item');

set local role authenticated;

-- ── Owner of A: a Cargills bill, routed in one call ───────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';

insert into t_c values ('bill1', rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', pg_temp.j('[{
  "account_id":"00000000-0000-0000-0000-00000000bb02","payee_text":"Cargills Food City","occurred_on":"2026-09-20",
  "occurred_at":"20:20","total":6380,"source":"scan","fingerprint":"btest1",
  "tick_item_ids":["00000000-0000-0000-0000-00000000bc03","00000000-0000-0000-0000-00000000bcb1"],
  "lines":[
    {"line_no":0,"raw_name":"WHITE SUGAR 1KG","category_id":"00000000-0000-0000-0000-00000000eb01","qty":2,"unit_text":"pcs",
     "amount":440,"fingerprint":"btest1-0-a",
     "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db01","qty":2,"unit_id":"PACK"}},
    {"line_no":1,"raw_name":"Havana Brown Egg","category_id":"00000000-0000-0000-0000-00000000eb01","qty":1,"unit_text":"pack",
     "amount":570,"fingerprint":"btest1-1-b",
     "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db02"}},
    {"line_no":2,"raw_name":"Anchor Hot Chocolate","category_id":"00000000-0000-0000-0000-00000000eb01","qty":2,"unit_text":"pcs",
     "amount":260,"fingerprint":"btest1-2-c",
     "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db03","qty":400,"unit_id":"G",
              "location_id":"00000000-0000-0000-0000-00000000cb02","due_date":null}},
    {"line_no":3,"raw_name":"Aquafina Drinking-Water","category_id":"00000000-0000-0000-0000-00000000eb01","amount":120,
     "fingerprint":"btest1-3-d","route":{"destiny":"expense"}},
    {"line_no":4,"raw_name":"Rice cooker","category_id":"00000000-0000-0000-0000-00000000eb03","amount":5000,
     "fingerprint":"btest1-4-e","route":{"destiny":"asset","learn":false}},
    {"line_no":5,"raw_name":"Bill discount / rounding","category_id":"00000000-0000-0000-0000-00000000eb01","amount":-10,
     "fingerprint":"btest1-5-f","route":{"destiny":"expense","learn":false}}
  ]}]')));

select is((select v -> 0 ->> 'status' || ' ' || (v -> 0 ->> 'lots') || ' ' || (v -> 0 ->> 'ticked') || ' '
                  || (v -> 0 ->> 'correlation_id' is not null) from t_c where k = 'bill1'),
  'imported 3 3 true', 'one call: imported, 3 lots, 3 list items ticked, one correlation');
select is((select total || ' ' || (select sum(amount) from transaction_line l where l.transaction_id = t.id)
             from money_transaction t where fingerprint = 'btest1'),
  '6380.00 6380.00', 'the expense is logged; lines add up to the total');
select is((select qty_initial || ' ' || qty_remaining || ' ' || unit_cost || ' ' || due_date || ' ' || location_id
                  || ' ' || purchased_on from pg_temp.lot('btest1-0-a')),
  '800.0000 800.0000 0.5500 2027-03-19 00000000-0000-0000-0000-00000000cb01 2026-09-20',
  'sugar: 2 packs = 800 g at Rs 0.55/g, bought on the bill date, best before +180 d, in its place');
select is((select qty_initial || ' ' || unit_cost || ' ' || coalesce(due_date::text, '-') || ' ' || coalesce(location_id::text, '-')
             from pg_temp.lot('btest1-1-b')),
  '10.0000 57.0000 - -', 'eggs: the line''s own unit (1 pack = 10 pcs) when the route gives none');
select is((select qty_initial || ' ' || unit_cost || ' ' || coalesce(due_date::text, '-') || ' ' || location_id
             from pg_temp.lot('btest1-2-c')),
  '400.0000 0.6500 - 00000000-0000-0000-0000-00000000cb02', 'hot chocolate: explicit qty, place and no due date');
select is((select count(distinct m.correlation_id)::int from stock_movement m
             join stock_lot k on k.id = m.lot_id join transaction_line l on l.id = k.transaction_line_id
            where l.transaction_id = (select id from money_transaction where fingerprint = 'btest1')),
  1, 'all lots of the bill share one correlation');
select is((select string_agg(l.line_no || ':' || l.destiny || ':' || coalesce(p.name, '-'), ' ' order by l.line_no)
             from transaction_line l left join product p on p.id = l.product_id
            where l.transaction_id = (select id from money_transaction where fingerprint = 'btest1')),
  '0:stock:Sugar 1:stock:Eggs 2:stock:Hot chocolate 3:expense:- 4:asset:- 5:expense:-',
  'each line knows its destiny and product');
select is((select string_agg(alias_norm || '=' || destiny || '=' || coalesce(product_id::text, '-'), ' ' order by alias_norm)
             from product_alias),
  'anchor hot chocolate=stock=00000000-0000-0000-0000-00000000db03 aquafina drinking water=expense=- '
  || 'havana brown egg=stock=00000000-0000-0000-0000-00000000db02 white sugar 1kg=stock=00000000-0000-0000-0000-00000000db01',
  'printed names are learned (also "not stock"); learn=false lines aren''t');
select is((select string_agg(coalesce(free_text, p.name) || ':' || done || ':' || (done_by_line is not null), ' '
                             order by coalesce(free_text, p.name))
             from shopping_list_item i left join product p on p.id = i.product_id),
  'Candles:true:false Eggs:true:true Not bought:false:false Sugar:true:true',
  'stocked products ticked with their bill line, the picked free-text item ticked, the rest open');
select is((select lots || ' ' || qty_remaining || ' ' || product_name from v_line_route
            where line_id = pg_temp.line('btest1-0-a')), '1 800.0000 Sugar', 'v_line_route shows where a line went');
select is((select merchant_name || ' ' || last_unit_cost || ' ' || times from v_product_price
            where product_id = '00000000-0000-0000-0000-00000000db01'), 'Cargills Food City 0.5500 1',
  'price per stock unit by shop');

-- Duplicate: nothing is routed twice.
select is((rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', pg_temp.j('[{
  "account_id":"00000000-0000-0000-0000-00000000bb02","payee_text":"Cargills Food City","occurred_on":"2026-09-20",
  "total":440,"source":"scan","fingerprint":"btest1",
  "lines":[{"line_no":0,"raw_name":"WHITE SUGAR 1KG","category_id":"00000000-0000-0000-0000-00000000eb01","amount":440,
            "fingerprint":"btest1-0-a","route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db01"}}]}]'))
   -> 0 ->> 'status') || ' ' || (select count(*) from stock_lot),
  'duplicate 3', 'a duplicate bill is skipped and creates no lots');

-- Bad routes roll the whole bill back.
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', '[{
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"X","occurred_on":"2026-09-21","total":100,
  "source":"scan","fingerprint":"bbad1","lines":[{"line_no":0,"raw_name":"Rice","amount":100,"fingerprint":"bbad1-0-a",
  "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000dbb1"}}]}]'::jsonb)$$,
  '23503', null, 'another household''s product is rejected');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', '[{
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"X","occurred_on":"2026-09-21","total":100,
  "source":"scan","fingerprint":"bbad2","lines":[{"line_no":0,"raw_name":"Salt","amount":100,"fingerprint":"bbad2-0-a",
  "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db04",
           "location_id":"00000000-0000-0000-0000-00000000cbb1"}}]}]'::jsonb)$$,
  '23503', null, 'another household''s place is rejected');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', pg_temp.j('[{
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"X","occurred_on":"2026-09-21","total":100,
  "source":"scan","fingerprint":"bbad3","lines":[{"line_no":0,"raw_name":"Hot choc","amount":100,"fingerprint":"bbad3-0-a",
  "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db03","qty":1,"unit_id":"PACK"}}]}]'))$$,
  'GDUNT', null, 'a unit the product can''t convert is refused');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', '[{
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"X","occurred_on":"2026-09-21","total":0,
  "source":"scan","fingerprint":"bbad4","lines":[
   {"line_no":0,"raw_name":"Salt","amount":10,"fingerprint":"bbad4-0-a"},
   {"line_no":1,"raw_name":"Discount","amount":-10,"fingerprint":"bbad4-1-b",
    "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db04"}}]}]'::jsonb)$$,
  '23514', null, 'a discount line can''t become stock');
select throws_ok($$select rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', '[{"type":"income",
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"X","occurred_on":"2026-09-21","total":100,
  "source":"scan","fingerprint":"bbad5","lines":[{"line_no":0,"raw_name":"Salary","amount":100,"fingerprint":"bbad5-0-a",
  "route":{"destiny":"expense"}}]}]'::jsonb)$$,
  '23514', null, 'only expense lines can be routed');
select is((select count(*)::int from money_transaction where fingerprint like 'bbad%'), 0, 'refused bills left nothing behind');

-- A second shop, cheaper, today; the same printed name is recognised again (learned). Sugar is on
-- the list again, so this bill ticks it.
insert into shopping_list_item (household_id, product_id) values
  ('00000000-0000-0000-0000-0000000fb1aa', '00000000-0000-0000-0000-00000000db01');
insert into t_c values ('bill2', rpc_import_bills('00000000-0000-0000-0000-0000000fb1aa', pg_temp.j('[{
  "account_id":"00000000-0000-0000-0000-00000000bb01","payee_text":"Keells","occurred_on":"TODAY","total":400,
  "source":"scan","fingerprint":"btest2",
  "lines":[{"line_no":0,"raw_name":"White Sugar 1kg","category_id":"00000000-0000-0000-0000-00000000eb01","amount":400,
            "qty":2,"unit_text":"pack","fingerprint":"btest2-0-a",
            "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-00000000db01"}}]}]')));
select is((select hits || ' ' || (select name from merchant m where m.id = a.merchant_id) from product_alias a
            where alias_norm = 'white sugar 1kg'), '2 Keells', 'the learned name counts its uses and where it was last seen');
select is((select string_agg(merchant_name || '=' || last_unit_cost, ' ' order by merchant_name) from v_product_price
            where product_id = '00000000-0000-0000-0000-00000000db01'),
  'Cargills Food City=0.5500 Keells=0.5000', 'prices by shop');
select is((select best_merchant || ' ' || best_unit_cost || ' ' || stock_unit_code from v_shopping_list
            where done_by_line = pg_temp.line('btest2-0-a')),
  'Keells 0.5000 g', 'the list shows the cheapest recent shop');
select is((select bought_at || ' ' || bought_on from v_shopping_list where id = '00000000-0000-0000-0000-00000000bc01'),
  'Cargills Food City 2026-09-20', '… and where a ticked item was bought');

-- ── Routing a bill that is already in Gedara ──────────────────────────────────
insert into t_c values ('manual', rpc_save_transaction('{
  "household_id":"00000000-0000-0000-0000-0000000fb1aa","type":"expense","account_id":"00000000-0000-0000-0000-00000000bb01",
  "payee_text":"Corner shop","occurred_on":"2026-09-23","total":150,"fingerprint":"mroute1",
  "lines":[{"raw_name":"Salt 1kg","category_id":"00000000-0000-0000-0000-00000000eb01","qty":1,"unit_text":"kg",
            "amount":150,"fingerprint":"mroute1-0-a"}]}'::jsonb));
insert into t_c values ('route', rpc_route_lines((select (v ->> 'id')::uuid from t_c where k = 'manual'),
  jsonb_build_array(jsonb_build_object('line_id', pg_temp.line('mroute1-0-a'), 'destiny', 'stock',
                                       'product_id', '00000000-0000-0000-0000-00000000db04'))));
select is((select (select v ->> 'lots' from t_c where k = 'route') || ' ' || qty_initial || ' ' || unit_cost || ' ' || purchased_on
             from pg_temp.lot('mroute1-0-a')), '1 1000.0000 0.1500 2026-09-23',
  'an existing bill''s line becomes stock (1 kg = 1000 g), dated by the bill');
select throws_ok($$select rpc_route_lines((select (v ->> 'id')::uuid from t_c where k = 'manual'),
  jsonb_build_array(jsonb_build_object('line_id', pg_temp.line('mroute1-0-a'), 'destiny', 'expense')))$$,
  'GDRTD', null, 'a line that already feeds the pantry can''t be routed again');
select throws_ok($$select rpc_route_lines((select (v ->> 'id')::uuid from t_c where k = 'manual'),
  jsonb_build_array(jsonb_build_object('line_id', pg_temp.line('btest1-3-d'), 'destiny', 'expense')))$$,
  '23503', null, 'lines of another bill are refused');

-- Editing a routed bill: header yes (keep_lines), lines no.
select throws_ok($$select rpc_save_transaction(jsonb_build_object(
  'id', (select v ->> 'id' from t_c where k = 'manual'), 'household_id', '00000000-0000-0000-0000-0000000fb1aa',
  'type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000bb01', 'occurred_on', '2026-09-23', 'total', 150,
  'lines', '[{"raw_name":"Salt","category_id":"00000000-0000-0000-0000-00000000eb01","amount":150,"fingerprint":"mroute1-0-z"}]'::jsonb))$$,
  'GDRTD', null, 'rewriting the lines of a routed bill is refused');
select lives_ok($$select rpc_save_transaction(jsonb_build_object(
  'id', (select v ->> 'id' from t_c where k = 'manual'), 'household_id', '00000000-0000-0000-0000-0000000fb1aa',
  'type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000bb02', 'payee_text', 'Corner shop',
  'occurred_on', '2026-09-24', 'total', 150, 'keep_lines', true))$$, 'editing the header keeps the lines');
select is((select t.account_id || ' ' || t.occurred_on || ' ' || (k.transaction_line_id is not null)
             from money_transaction t join transaction_line l on l.transaction_id = t.id
             join stock_lot k on k.transaction_line_id = l.id where t.fingerprint = 'mroute1'),
  '00000000-0000-0000-0000-00000000bb02 2026-09-24 true', '… and the lot is still linked');
select throws_ok($$select rpc_save_transaction(jsonb_build_object(
  'id', (select v ->> 'id' from t_c where k = 'manual'), 'household_id', '00000000-0000-0000-0000-0000000fb1aa',
  'type', 'expense', 'account_id', '00000000-0000-0000-0000-00000000bb02', 'occurred_on', '2026-09-24', 'total', 999,
  'keep_lines', true))$$, '23514', null, 'with kept lines the total must still match');

-- ── Deleting bills ────────────────────────────────────────────────────────────
-- Keells bill: nothing used → its stock goes, the item it ticked opens again.
select is((select done::text from shopping_list_item where product_id = '00000000-0000-0000-0000-00000000db01'
            and done_by_line = pg_temp.line('btest2-0-a')), 'true', 'the Keells bill ticked the new sugar item');
select lives_ok($$select rpc_delete_transaction((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill2'))$$,
  'an untouched bill is deleted');
select is((select count(*)::int || ' ' || sum(qty_remaining) from stock_lot
            where product_id = '00000000-0000-0000-0000-00000000db01' and transaction_line_id is null),
  '1 0.0000', '… its lot was taken back (kept, empty, in the journal)');
select is((select count(*)::int from shopping_list_item where product_id = '00000000-0000-0000-0000-00000000db01' and not done),
  1, '… and the item it ticked is open again');
select is((select last_unit_cost || ' ' || qty from v_product_stock where product_id = '00000000-0000-0000-0000-00000000db01'),
  '0.5500 800.0000', 'a taken-back purchase is no longer the last price');
select is((select string_agg(merchant_name, ' ') from v_product_price where product_id = '00000000-0000-0000-0000-00000000db01'),
  'Cargills Food City', '… nor a price by shop');

-- Cargills bill: some sugar used → refused; then deleted keeping the stock.
select lives_ok($$select rpc_consume('{"household_id":"00000000-0000-0000-0000-0000000fb1aa",
  "product_id":"00000000-0000-0000-0000-00000000db01","qty":100}'::jsonb)$$, 'use 100 g of sugar');
select throws_ok($$select rpc_delete_transaction((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill1'))$$,
  'GDUSE', null, 'a bill whose stock was used can''t take it back');
select is((select count(*)::int from money_transaction where fingerprint = 'btest1'), 1, '… and nothing was deleted');

-- ── Viewer and B ──────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb103","role":"authenticated"}';
select throws_ok($$select rpc_route_lines((select (v ->> 'id')::uuid from t_c where k = 'manual'), '[]'::jsonb)$$,
  '42501', null, 'viewer can''t route');
select throws_ok($$select rpc_delete_transaction((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill1'), true)$$,
  '42501', null, 'viewer can''t delete bills');
select is((select count(*)::int from v_line_route where transaction_id = (select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill1')),
  6, 'viewer sees where lines went');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb201","role":"authenticated"}';
select throws_ok($$select rpc_route_lines((select (v ->> 'id')::uuid from t_c where k = 'manual'), '[]'::jsonb)$$,
  '42501', null, 'B can''t route A''s bill');
select throws_ok($$select rpc_delete_transaction((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill1'))$$,
  '42501', null, 'B can''t delete A''s bill');
select is((select done::text from shopping_list_item where id = '00000000-0000-0000-0000-00000000bcb1'), 'false',
  'A''s import couldn''t tick B''s item');
select is((select count(*)::int from v_line_route) + (select count(*)::int from v_product_price)
          + (select count(*)::int from v_shopping_list), 1, 'B sees only its own list item in the new views');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000fb101","role":"authenticated"}';
select lives_ok($$select rpc_delete_transaction((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill1'), true)$$,
  'delete the bill but keep the stock');
select is((select count(*)::int || ' ' || sum(qty_remaining) from stock_lot
            where product_id in ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000db02',
                                 '00000000-0000-0000-0000-00000000db03') and qty_remaining > 0),
  '3 1110.0000', '… the remaining stock stays (700 g + 10 eggs + 400 g)');

-- Invariant after everything.
select is((select count(*)::int from stock_lot k
            where k.household_id = '00000000-0000-0000-0000-0000000fb1aa'
              and k.qty_remaining <> (select coalesce(sum(m.delta), 0) from stock_movement m where m.lot_id = k.id)),
  0, 'qty_remaining = Σ delta for every lot');

select * from finish();
rollback;
