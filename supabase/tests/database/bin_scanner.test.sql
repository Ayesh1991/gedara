-- Phase 11 behaviour: what a scan at the bin does. Used (pieces; a sized pack whole, the rest of a
-- part-used pack, an opened pack emptied; a scale-jar product moved into its jar; nothing in stock →
-- shopping list), an exact replay moving nothing, unknown barcodes waiting and applied after linking,
-- labels and other text, UPC-A = EAN-13, Check, Add (ticks the list; waits after a bill; a later bill
-- nets it out), the scanner's own Undo, Opened, Waste, a bad event stored without blocking the queue,
-- settings and commands, the names list, the limits (pause + held, resume, undo since, GDRTE), and a
-- scanner key refused on the scale's endpoint and after removal.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(74);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create temp table t_c (k text primary key, v jsonb) on commit drop;
grant all on t_c to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f11d01', 'p11-owner@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-000000f11daa', 'Bin A');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000f11d01', 'owner');
insert into category (id, household_id, key, name, default_destiny) values
  ('00000000-0000-0000-0000-000000e11d01', '00000000-0000-0000-0000-000000f11daa', 'grocery', 'Grocery', 'stock');
insert into account (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-000000b11d01', '00000000-0000-0000-0000-000000f11daa', 'Cash', 'cash');
insert into location (id, household_id, name, kind) values
  ('00000000-0000-0000-0000-000000c11d00', '00000000-0000-0000-0000-000000f11daa', 'Pantry', 'shelf');
insert into product (id, household_id, name, stock_unit_id, default_location_id) values
  ('00000000-0000-0000-0000-000000d11d01', '00000000-0000-0000-0000-000000f11daa', 'Highland Yoghurt', pg_temp.u('pcs'), null),
  ('00000000-0000-0000-0000-000000d11d02', '00000000-0000-0000-0000-000000f11daa', 'Coconut milk', pg_temp.u('ml'), null),
  ('00000000-0000-0000-0000-000000d11d03', '00000000-0000-0000-0000-000000f11daa', 'Milk powder', pg_temp.u('g'),
   '00000000-0000-0000-0000-000000c11d00'),
  ('00000000-0000-0000-0000-000000d11d04', '00000000-0000-0000-0000-000000f11daa', 'Ice cream', pg_temp.u('ml'), null),
  ('00000000-0000-0000-0000-000000d11d05', '00000000-0000-0000-0000-000000f11daa', 'Toothbrush', pg_temp.u('pcs'), null);
insert into location (id, household_id, name, kind, holds_product_id, tare_g) values
  ('00000000-0000-0000-0000-000000c11d01', '00000000-0000-0000-0000-000000f11daa', 'Milk powder jar', 'container',
   '00000000-0000-0000-0000-000000d11d03', 300);

create function pg_temp.tok() returns text language sql stable as
  $$ select encode(extensions.digest(convert_to((select v ->> 'token' from t_c where k = 'dev'), 'UTF8'), 'sha256'), 'hex') $$;
create function pg_temp.dev() returns uuid language sql stable as
  $$ select (v ->> 'id')::uuid from t_c where k = 'dev' $$;
create function pg_temp.sync(p jsonb) returns jsonb language sql volatile as
  $$ select public.rpc_scanner_sync(pg_temp.tok(), '{"v":1,"fw":"0.1.0","epoch":7,"boot":3,"up":100000}'::jsonb || p) $$;
-- One event. Scan times are spread 3 minutes apart (seq 1 = 197 min ago) unless p_now.
create function pg_temp.sc(p_seq int, p_mode text, p_code text, p_n int default null, p_now boolean default false)
returns jsonb language sql stable as
  $$ select jsonb_strip_nulls(jsonb_build_object('seq', p_seq, 'b', 3, 't', 100000, 'type', 'scan', 'mode', p_mode,
            'code', p_code, 'n', p_n,
            'at', case when not p_now then round(extract(epoch from now() - make_interval(mins => 200 - 3 * p_seq)) * 1000) end)) $$;
create function pg_temp.one(p jsonb) returns jsonb language sql volatile as
  $$ select pg_temp.sync(jsonb_build_object('events', jsonb_build_array(p))) $$;
create function pg_temp.res(p_k text, p_i int default 0) returns jsonb language sql stable as
  $$ select v -> 'results' -> p_i from t_c where k = p_k $$;
create function pg_temp.lft(p_product uuid) returns numeric language sql stable security definer as
  $$ select coalesce(sum(qty_remaining), 0) from public.stock_lot where product_id = p_product $$;
create function pg_temp.at(p_loc uuid) returns numeric language sql stable security definer as
  $$ select coalesce(sum(qty_remaining), 0) from public.stock_lot where location_id = p_loc $$;
create function pg_temp.scan(p_seq int) returns uuid language sql stable security definer as
  $$ select id from public.bin_scan where household_id = '00000000-0000-0000-0000-000000f11daa' and seq = p_seq $$;
create function pg_temp.batch(p_from int, p_mode text, p_code text) returns jsonb language sql volatile as
  $$ select pg_temp.sync(jsonb_build_object('events',
       (select jsonb_agg(pg_temp.sc(i, p_mode, p_code, null, true)) from generate_series(p_from, p_from + 19) i))) $$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000f11d01","role":"authenticated"}';

-- ── Setup: a scanner, barcodes (one scan = one pack), stock ───────────────────
insert into t_c values ('dev', rpc_scanner_create('00000000-0000-0000-0000-000000f11daa', 'Bin scanner'));
select is(length((select v ->> 'token' from t_c where k = 'dev')), 43, 'the key is shown once, 43 characters');
insert into product_barcode (household_id, product_id, barcode, unit_id, qty) values
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d01', '4790000000011', null, 1),
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d02', '4790000000028', pg_temp.u('ml'), 400),
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d03', '4790000000035', pg_temp.u('g'), 400),
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d04', '4790000000042', pg_temp.u('ml'), 1000),
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d05', '0123456789012', null, 1);
insert into t_c values
  ('p1', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d01","qty":6}')),
  ('p2', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d02","qty":1200}')),
  ('p3', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d03","qty":400}')),
  ('p4', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d03","qty":120,
                        "location_id":"00000000-0000-0000-0000-000000c11d01"}')),
  ('p5', rpc_purchase('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d05","qty":3}'));

reset role;
set local role service_role;

-- ── Used: pieces ──────────────────────────────────────────────────────────────
insert into t_c values ('s1', pg_temp.one(pg_temp.sc(1, 'use', '4790000000011')));
select is(pg_temp.res('s1') ->> 'status', 'used', 'a yoghurt cup: used');
select is((pg_temp.res('s1') ->> 'left_qty')::numeric, 5::numeric, '… 6 → 5 left');
select is(pg_temp.res('s1') ->> 'dn', 'Highland Yoghurt', '… with the name for the screen');
select is(jsonb_typeof((select v -> 'cat' -> 'items' from t_c where k = 's1')), 'array', 'the first answer carries the names list');
insert into t_c values ('s1r', pg_temp.one(pg_temp.sc(1, 'use', '4790000000011')));
select is((pg_temp.res('s1r') ->> 'replayed')::boolean, true, 'the same epoch + seq replays');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 5::numeric, '… and nothing is taken twice');
insert into t_c values ('s2', pg_temp.one(pg_temp.sc(2, 'use', '4790000000011', 3)));
select is((pg_temp.res('s2') ->> 'left_qty')::numeric, 2::numeric, 'number key 3: three cups');

-- ── Used: a pack with a size ──────────────────────────────────────────────────
insert into t_c values ('s3', pg_temp.one(pg_temp.sc(3, 'use', '4790000000028')));
select is((pg_temp.res('s3') ->> 'qty')::numeric, -400::numeric, 'coconut milk, three whole packs: one pack (400 ml) goes');
reset role;
set local role authenticated;
select lives_ok($$select rpc_consume('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d02","qty":200}')$$,
  'the app takes 200 ml of the next pack');
reset role;
set local role service_role;
insert into t_c values ('s4', pg_temp.one(pg_temp.sc(4, 'use', '4790000000028')));
select is((pg_temp.res('s4') ->> 'qty')::numeric, -200::numeric, 'a part-used pack: only its rest (200 ml) goes');
reset role;
set local role authenticated;
select lives_ok($$select rpc_open('{"household_id":"00000000-0000-0000-0000-000000f11daa","product_id":"00000000-0000-0000-0000-000000d11d02"}')$$,
  'the last pack is opened in the app');
reset role;
set local role service_role;
insert into t_c values ('s5', pg_temp.one(pg_temp.sc(5, 'use', '4790000000028')));
select is((pg_temp.res('s5') ->> 'left_qty')::numeric, 0::numeric, 'the opened pack is emptied: none left');
select is((select source from shopping_list_item where id = (pg_temp.res('s5') ->> 'list_item_id')::uuid), 'scanner',
  '… and the last one going puts it on the shopping list');

-- ── Used: nothing in stock ────────────────────────────────────────────────────
insert into t_c values ('s6', pg_temp.one(pg_temp.sc(6, 'use', '4790000000042')));
select is(pg_temp.res('s6') ->> 'status', 'no_stock', 'ice cream was never entered: no stock');
select is((pg_temp.res('s6') ->> 'on_list')::boolean, true, '… so it goes on the shopping list');
insert into t_c values ('s7', pg_temp.one(pg_temp.sc(7, 'use', '4790000000042')));
select is((select count(*)::int from shopping_list_item where product_id = '00000000-0000-0000-0000-000000d11d04'), 1,
  'a second empty tub adds no second line');

-- ── Used: a product that lives in a kitchen-scale jar ─────────────────────────
insert into t_c values ('s8', pg_temp.one(pg_temp.sc(8, 'use', '4790000000035')));
select is(pg_temp.res('s8') ->> 'status', 'moved', 'milk powder has a jar: the pack is moved, not used');
select is(pg_temp.at('00000000-0000-0000-0000-000000c11d01'), 520::numeric, '… 120 + 400 g in the jar');
select is(pg_temp.at('00000000-0000-0000-0000-000000c11d00'), 0::numeric, '… none left in the pantry');
insert into t_c values ('s9', pg_temp.one(pg_temp.sc(9, 'use', '4790000000035')));
select is(pg_temp.res('s9') ->> 'status', 'in_jar', 'already in the jar: nothing happens');

-- ── Unknown, labels, other text, UPC-A ────────────────────────────────────────
insert into t_c values ('s10', pg_temp.one(pg_temp.sc(10, 'use', '4799999999999')));
select is(pg_temp.res('s10') ->> 'status', 'unknown', 'a barcode no product has: it waits');
insert into t_c values ('s11', pg_temp.one(pg_temp.sc(11, 'use', 'HL:LOC:ABCDEF')));
select is(pg_temp.res('s11') ->> 'status', 'not_pantry', 'a place label is not a pantry item');
insert into t_c values ('s12', pg_temp.one(pg_temp.sc(12, 'use', 'hello <b>world</b>!')));
select is(pg_temp.res('s12') ->> 'status' || ' ' || (pg_temp.res('s12') ->> 'code_kind'), 'not_pantry other', 'any other text does nothing');
insert into t_c values ('s13', pg_temp.one(pg_temp.sc(13, 'check',
  'https://gedara.vercel.app/s/' || (select code from product where id = '00000000-0000-0000-0000-000000d11d01'))));
select is(pg_temp.res('s13') ->> 'status' || ' ' || round((pg_temp.res('s13') ->> 'left_qty')::numeric), 'checked 2', 'Check on our own label (URL form): 2 left');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 2::numeric, '… and nothing changed');
insert into t_c values ('s14', pg_temp.one(pg_temp.sc(14, 'use', '123456789012')));
select is((pg_temp.res('s14') ->> 'left_qty')::numeric, 2::numeric, 'a 12-digit UPC-A finds its 13-digit EAN: toothbrush 3 → 2');

-- ── Add, and the scanner's own Undo ───────────────────────────────────────────
insert into t_c values ('s15', pg_temp.one(pg_temp.sc(15, 'add', '4790000000011', 2)));
select is(pg_temp.res('s15') ->> 'status' || ' ' || round((pg_temp.res('s15') ->> 'left_qty')::numeric), 'added 4', 'Add ×2: yoghurt 2 → 4');
insert into t_c values ('s16', pg_temp.one(pg_temp.sc(16, 'add', '4790000000042')));
select is((pg_temp.res('s16') ->> 'qty')::numeric, 1000::numeric, 'Add ice cream: one 1,000 ml tub');
select is((select done from shopping_list_item where product_id = '00000000-0000-0000-0000-000000d11d04'), true,
  '… and its shopping-list line is done');
insert into t_c values ('s17', pg_temp.one('{"seq":17,"b":3,"t":100000,"type":"undo"}'::jsonb
  || jsonb_build_object('at', round(extract(epoch from now() - interval '149 minutes') * 1000))));
select is(pg_temp.res('s17') ->> 'status', 'undo', 'the * key undoes the scanner''s last scan');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d04'), 0::numeric, '… the tub is gone again');
select is((select done from shopping_list_item where product_id = '00000000-0000-0000-0000-000000d11d04'), false,
  '… and it is back on the list');
insert into t_c values ('s18', pg_temp.one('{"seq":18,"b":3,"t":100000,"type":"undo"}'::jsonb
  || jsonb_build_object('at', round(extract(epoch from now() - interval '146 minutes') * 1000))));
select is(pg_temp.res('s18') ->> 'status', 'undo_none', 'a second * has nothing to undo');

-- ── Opened, Waste, a bad event ────────────────────────────────────────────────
insert into t_c values ('s19', pg_temp.one(pg_temp.sc(19, 'open', '0123456789012')));
select is(pg_temp.res('s19') ->> 'status', 'opened', 'Opened: one toothbrush');
select is((select count(*)::int from stock_lot where product_id = '00000000-0000-0000-0000-000000d11d05' and opened_at is not null
             and qty_remaining = 1), 1, '… as its own opened lot');
insert into t_c values ('s20', pg_temp.one(pg_temp.sc(20, 'open', '4790000000042')));
select is(pg_temp.res('s20') ->> 'status', 'nothing_to_open', 'nothing unopened to open');
insert into t_c values ('s21', pg_temp.one(pg_temp.sc(21, 'waste', '4790000000011')));
select is(pg_temp.res('s21') ->> 'status' || ' ' || round((pg_temp.res('s21') ->> 'left_qty')::numeric), 'wasted 3', 'Waste: yoghurt 4 → 3');
select is((select count(*)::int from stock_movement where product_id = '00000000-0000-0000-0000-000000d11d01' and reason = 'waste'
             and note = 'Bin scanner'), 1, '… in the journal as waste, from the bin scanner');
insert into t_c values ('s22', pg_temp.one(pg_temp.sc(22, 'steal', '4790000000011')));
select is(pg_temp.res('s22') ->> 'status', 'error', 'an event Gedara doesn''t know is stored as an error');
select is((select v -> 'acked' from t_c where k = 's22'), '[22]'::jsonb, '… and acked, so it can''t block the queue');

-- ── A bill for something Add already put in; Add right after a bill ───────────
reset role;
set local role authenticated;
insert into t_c values ('bill', rpc_import_bills('00000000-0000-0000-0000-000000f11daa', replace('[{
  "account_id":"00000000-0000-0000-0000-000000b11d01","payee_text":"Keells","occurred_on":"TODAY","total":600,"source":"scan",
  "fingerprint":"bp11","lines":[
    {"line_no":0,"raw_name":"HIGHLAND YOGHURT","category_id":"00000000-0000-0000-0000-000000e11d01","qty":6,"unit_text":"pcs",
     "amount":600,"fingerprint":"bp11-0-a",
     "route":{"destiny":"stock","product_id":"00000000-0000-0000-0000-000000d11d01","qty":6}}]}]', 'TODAY', current_date::text)::jsonb));
insert into t_c values ('settle', rpc_bin_add_settle((select (v -> 0 ->> 'id')::uuid from t_c where k = 'bill')));
select is((select (v -> 'items' -> 0 ->> 'qty')::numeric from t_c where k = 'settle'), 2::numeric,
  'the bill brings 6; the 2 that Add already put in are not counted twice');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 7::numeric, '… 3 + 6 − 2 = 7');
select isnt((select bill_line_id from bin_scan where id = pg_temp.scan(15)), null, '… and that Add scan is matched to the bill');
reset role;
set local role service_role;
insert into t_c values ('s23', pg_temp.one(pg_temp.sc(23, 'add', '4790000000011')));
select is(pg_temp.res('s23') ->> 'status' || ' ' || round((pg_temp.res('s23') ->> 'bill_qty')::numeric), 'bill_guard 6',
  'Add right after a bill waits for a person');
reset role;
set local role authenticated;
insert into t_c values ('r23', rpc_bin_scan_resolve(pg_temp.scan(23), 'apply'));
select is((select v ->> 'status' from t_c where k = 'r23'), 'added', '"Add 1 more" adds it');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 8::numeric, '… 7 → 8');

-- ── The unknown barcode is linked once; the waiting scan is applied ───────────
insert into product_barcode (household_id, product_id, barcode) values
  ('00000000-0000-0000-0000-000000f11daa', '00000000-0000-0000-0000-000000d11d01', '4799999999999');
insert into t_c values ('r10', rpc_bin_scan_resolve(pg_temp.scan(10), 'apply'));
select is((select v ->> 'status' || ' ' || (v ->> 'applied') from t_c where k = 'r10'), 'used 1', 'after linking, the waiting scan is applied');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 7::numeric, '… 8 → 7');
select throws_ok(format($$select rpc_bin_scan_undo(%L)$$, pg_temp.scan(1)), 'GDUND', null,
  'a scan whose stock has changed since can''t be undone');

-- ── Settings and commands ─────────────────────────────────────────────────────
select lives_ok(format($$select rpc_device_update(%L, '{"settings":{"eye":"key","mode_s":45,"keymap":"147*2580369#ABCD"}}')$$, pg_temp.dev()),
  'scanner settings are accepted');
select throws_ok(format($$select rpc_device_update(%L, '{"settings":{"keymap":"1111456B789C*0#D"}}')$$, pg_temp.dev()),
  '23514', null, 'a key map must have every key once');
select throws_ok(format($$select rpc_device_command(%L, 'tare')$$, pg_temp.dev()), '23514', null, 'a scanner has no tare command');
select lives_ok(format($$select rpc_device_command(%L, 'beep')$$, pg_temp.dev()), 'Test beep is queued');
reset role;
set local role service_role;
insert into t_c values ('s24', pg_temp.one(pg_temp.sc(24, 'check', '4790000000011')));
select is((select v -> 'commands' -> 0 ->> 'command' from t_c where k = 's24'), 'beep', 'the command comes with the next answer');
select is((select (v ->> 'next_ms')::int from t_c where k = 's24'), 5000, '… and the scanner checks back soon, else every 30 minutes');
select is((select v -> 'config' ->> 'eye' from t_c where k = 's24'), 'key', '… with its settings');

-- ── Limits: 20 scans in a minute → paused, scans held ─────────────────────────
insert into t_c values ('b30', pg_temp.batch(30, 'use', '4798888888888'));
select is(jsonb_array_length((select v -> 'acked' from t_c where k = 'b30')), 20, '20 scans in one minute are still taken');
insert into t_c values ('s50', pg_temp.one(pg_temp.sc(50, 'use', '4790000000011', null, true)));
select is(pg_temp.res('s50') ->> 'status', 'held', 'the 21st is held');
select is((select (v ->> 'paused_now')::boolean from t_c where k = 's50'), true, '… the scanner is paused (the function alerts the owner)');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 7::numeric, '… and no stock moved');
insert into t_c values ('s51', pg_temp.sync(jsonb_build_object('cat_v', (select v -> 'cat' ->> 'v' from t_c where k = 's50'),
  'events', jsonb_build_array(pg_temp.sc(51, 'check', '4790000000011', null, true)))));
select is(pg_temp.res('s51') ->> 'status', 'checked', 'Check still works while paused');
select is((select v -> 'cat' ? 'items' from t_c where k = 's51'), false, 'an unchanged names list is not sent again');

reset role;
set local role authenticated;
select ok(exists (select 1 from attention_feed('00000000-0000-0000-0000-000000f11daa') a where a.kind = 'bin_unknown'),
  'Attention: barcodes to link');
select ok(exists (select 1 from attention_feed('00000000-0000-0000-0000-000000f11daa') a where a.kind = 'bin_paused' and a.severity = 'red'),
  'Attention: the scanner is paused');
select ok(exists (select 1 from attention_feed('00000000-0000-0000-0000-000000f11daa') a where a.kind = 'bin_waiting'),
  'Attention: scans waiting');
insert into t_c values ('resume', rpc_scanner_resume(pg_temp.dev(), 'apply'));
select is((select (v ->> 'held')::int from t_c where k = 'resume'), 1, 'the owner resumes and applies the held scan');
select is(pg_temp.lft('00000000-0000-0000-0000-000000d11d01'), 6::numeric, '… 7 → 6');
select is((select paused_at from device where id = pg_temp.dev()), null, '… and the scanner runs again');
insert into t_c values ('since', rpc_scanner_undo_since(pg_temp.dev(), now() - interval '1 hour'));
select cmp_ok((select (v ->> 'undone')::int from t_c where k = 'since'), '>', 0, '"Undo everything since" takes scans back');

-- ── 120 events per 10 minutes ─────────────────────────────────────────────────
reset role;
set local role service_role;
insert into t_c values ('b60', pg_temp.batch(60, 'check', '4790000000011')), ('b80', pg_temp.batch(80, 'check', '4790000000011')),
  ('b100', pg_temp.batch(100, 'check', '4790000000011'));
select throws_ok($$select pg_temp.batch(120, 'check', '4790000000011')$$, 'GDRTE', null, 'more than 120 events in 10 minutes: slow down');

-- ── Keys stay with their own endpoint; a removed scanner is refused ───────────
select throws_ok($$select public.rpc_scale_sync(pg_temp.tok(), '{"v":1,"fw":"0.1.0","epoch":7,"boot":3,"up":100000}')$$,
  '42501', null, 'a scanner''s key is not a scale''s key');
reset role;
set local role authenticated;
select lives_ok(format($$select rpc_device_revoke(%L)$$, pg_temp.dev()), 'the owner removes the scanner');
reset role;
set local role service_role;
select throws_ok($$select pg_temp.sync('{}')$$, '42501', null, 'a removed scanner is refused');

select * from finish();
rollback;
