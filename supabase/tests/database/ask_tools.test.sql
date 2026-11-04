-- Ask Gedara's read-only functions (Phase 10, migration 100): the right numbers for spending, bills,
-- what's due, instalments, where things are, pantry, balances, budget and warranties; bounds refused;
-- valuables never shown (not even to the owner); viewers may ask; another household gets null; the
-- functions are invoker, authenticated-only, and never touch SMS, the house, tokens or files.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create function pg_temp.u(p_code text) returns uuid language sql stable as
  $$ select id from public.unit where household_id is null and code = p_code $$;
create function pg_temp.today() returns date language sql stable as
  $$ select (now() at time zone 'Asia/Colombo')::date $$;

-- ── Pure: instalment dates (same cases as instalments.test.ts) ────────────────
select is(private.instalment_date('2026-01-31', 2), '2026-02-28'::date, 'instalment after 31 Jan falls on 28 Feb');
select is(private.instalment_date('2026-01-31', 3), '2026-03-31'::date, '… and back on 31 Mar');
select is(private.instalment_date('2024-01-31', 2), '2024-02-29'::date, 'leap year: 29 Feb');
select is(private.instalment_date('2026-04-09', 12), '2027-03-09'::date, 'Toyota: 12th of 12 on 9 Mar 2027');

-- ── Fixtures ──────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e5001', 'askt-owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000e5003', 'askt-viewer-a@test.local'),
  ('00000000-0000-0000-0000-0000000e6001', 'askt-owner-b@test.local');
insert into household (id, name) values
  ('00000000-0000-0000-0000-0000000e50aa', 'AskT A'),
  ('00000000-0000-0000-0000-0000000e60bb', 'AskT B');
insert into household_member (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5001', 'owner'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5003', 'viewer'),
  ('00000000-0000-0000-0000-0000000e60bb', '00000000-0000-0000-0000-0000000e6001', 'owner');
insert into category (id, household_id, key, name, kind, default_destiny) values
  ('00000000-0000-0000-0000-0000000e5c01', '00000000-0000-0000-0000-0000000e50aa', 'grocery', 'Grocery', 'expense', 'expense'),
  ('00000000-0000-0000-0000-0000000e5c03', '00000000-0000-0000-0000-0000000e50aa', 'dining', 'Dining out', 'expense', 'expense'),
  ('00000000-0000-0000-0000-0000000e6c01', '00000000-0000-0000-0000-0000000e60bb', 'grocery', 'Grocery', 'expense', 'expense');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000e5c02', '00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5c01', 'Fish & seafood'),
  ('00000000-0000-0000-0000-0000000e6c02', '00000000-0000-0000-0000-0000000e60bb', '00000000-0000-0000-0000-0000000e6c01', 'Fish & seafood');
insert into account (id, household_id, name, kind, institution, last4, credit_limit, opening_balance, opening_on) values
  ('00000000-0000-0000-0000-0000000e5a01', '00000000-0000-0000-0000-0000000e50aa', 'Cash', 'cash', null, null, null, 50000, '2026-01-01'),
  ('00000000-0000-0000-0000-0000000e5a02', '00000000-0000-0000-0000-0000000e50aa', 'BOC Savings', 'bank', 'BOC', '319', null, 237010.25, '2026-01-01'),
  ('00000000-0000-0000-0000-0000000e5a03', '00000000-0000-0000-0000-0000000e50aa', 'Seylan card', 'credit_card', 'Seylan', '6029', 100000, 0, '2026-01-01'),
  ('00000000-0000-0000-0000-0000000e6a01', '00000000-0000-0000-0000-0000000e60bb', 'Cash B', 'cash', null, null, null, 1, '2026-01-01');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-0000000e5b01', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Keells Super', '2026-06-05', 2000, 'askt1'),
  ('00000000-0000-0000-0000-0000000e5b02', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Negombo Fish', '2026-07-10', 3000, 'askt2'),
  ('00000000-0000-0000-0000-0000000e5b03', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Keells Super', '2026-05-20', 500, 'askt3'),
  ('00000000-0000-0000-0000-0000000e5b04', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a03', 'Pizza Hut', '2026-07-15', 2500, 'askt4'),
  ('00000000-0000-0000-0000-0000000e6b01', '00000000-0000-0000-0000-0000000e60bb', 'expense', '00000000-0000-0000-0000-0000000e6a01', 'Fish B', '2026-06-10', 9999, 'asktb1');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b01', 0, 'FISH SALAYA', '00000000-0000-0000-0000-0000000e5c02', 1200, 'askt1-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b01', 1, 'KEERI SAMBA', '00000000-0000-0000-0000-0000000e5c01', 800, 'askt1-1'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b02', 0, 'TUNA 1KG', '00000000-0000-0000-0000-0000000e5c02', 3000, 'askt2-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b03', 0, 'FISH SALAYA', '00000000-0000-0000-0000-0000000e5c02', 500, 'askt3-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b04', 0, 'PIZZA', '00000000-0000-0000-0000-0000000e5c03', 2500, 'askt4-0'),
  ('00000000-0000-0000-0000-0000000e60bb', '00000000-0000-0000-0000-0000000e6b01', 0, 'FISH', '00000000-0000-0000-0000-0000000e6c02', 9999, 'asktb1-0');
insert into category (id, household_id, parent_id, name) values
  ('00000000-0000-0000-0000-0000000e5c04', '00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5c03', 'Subscriptions'),
  ('00000000-0000-0000-0000-0000000e5c05', '00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5c01', 'Cocconut milk'),
  ('00000000-0000-0000-0000-0000000e5c06', '00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5c01', 'Dairy & milk');
insert into money_transaction (id, household_id, type, account_id, payee_text, occurred_on, total, fingerprint) values
  ('00000000-0000-0000-0000-0000000e5b05', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'CARGILLS - KURANA', '2026-08-02', 100, 'askt5'),
  ('00000000-0000-0000-0000-0000000e5b06', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Cargills Food City', '2026-08-03', 200, 'askt6'),
  ('00000000-0000-0000-0000-0000000e5b07', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'CLAUDE.AI SUBSCRIPTION SAN FRANCISCO', '2026-08-04', 7000, 'askt7'),
  ('00000000-0000-0000-0000-0000000e5b08', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Milco', '2026-08-05', 900, 'askt8'),
  ('00000000-0000-0000-0000-0000000e5b09', '00000000-0000-0000-0000-0000000e50aa', 'expense', '00000000-0000-0000-0000-0000000e5a01', 'Milco', '2026-08-06', 450, 'askt9');
insert into transaction_line (household_id, transaction_id, line_no, raw_name, category_id, amount, fingerprint) values
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b05', 0, 'SUGAR', '00000000-0000-0000-0000-0000000e5c01', 100, 'askt5-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b06', 0, 'SALT', '00000000-0000-0000-0000-0000000e5c01', 200, 'askt6-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b07', 0, 'Claude Pro', '00000000-0000-0000-0000-0000000e5c04', 7000, 'askt7-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b08', 0, 'MILK 1L', '00000000-0000-0000-0000-0000000e5c06', 900, 'askt8-0'),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5b09', 0, 'YOGHURT', '00000000-0000-0000-0000-0000000e5c06', 450, 'askt9-0');
insert into budget (household_id, category_id, month, amount) values
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5c01', '2026-06-01', 5000);
insert into instalment_plan (id, household_id, account_id, kind, name, monthly, total_count, first_on) values
  ('00000000-0000-0000-0000-0000000e5e01', '00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5a03', 'card',
   'Toyota', 6470.72, 12, '2026-04-09');
insert into recurring_rule (id, household_id, name, account_id, expected_amount, first_due) values
  ('00000000-0000-0000-0000-0000000e5f01', '00000000-0000-0000-0000-0000000e50aa', 'CEB', '00000000-0000-0000-0000-0000000e5a01', 1100, '2027-03-05');
insert into recurring_rule (id, household_id, name, account_id, expected_amount, first_due, every_unit) values
  ('00000000-0000-0000-0000-0000000e5f02', '00000000-0000-0000-0000-0000000e50aa', 'Water', '00000000-0000-0000-0000-0000000e5a01', 500,
   pg_temp.today() - 10, 'year');
insert into location (id, household_id, name) values
  ('00000000-0000-0000-0000-0000000e5101', '00000000-0000-0000-0000-0000000e50aa', 'Garage'),
  ('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e50aa', 'Kitchen'),
  ('00000000-0000-0000-0000-0000000e5103', '00000000-0000-0000-0000-0000000e50aa', 'Safe');
insert into asset (id, household_id, name, location_id, warranty_until) values
  ('00000000-0000-0000-0000-0000000e5201', '00000000-0000-0000-0000-0000000e50aa', 'Bosch drill', '00000000-0000-0000-0000-0000000e5101', null),
  ('00000000-0000-0000-0000-0000000e5202', '00000000-0000-0000-0000-0000000e50aa', 'Gold chain', '00000000-0000-0000-0000-0000000e5102', null),
  ('00000000-0000-0000-0000-0000000e5203', '00000000-0000-0000-0000-0000000e50aa', 'TV', '00000000-0000-0000-0000-0000000e5102', pg_temp.today() + 30),
  ('00000000-0000-0000-0000-0000000e5204', '00000000-0000-0000-0000-0000000e50aa', 'Gold watch', '00000000-0000-0000-0000-0000000e5101', pg_temp.today() + 10),
  ('00000000-0000-0000-0000-0000000e5205', '00000000-0000-0000-0000-0000000e50aa', 'Spare drill', '00000000-0000-0000-0000-0000000e5103', pg_temp.today() + 5);
insert into product (id, household_id, name, stock_unit_id, due_type) values
  ('00000000-0000-0000-0000-0000000e5301', '00000000-0000-0000-0000-0000000e50aa', 'Basmati rice', pg_temp.u('g'), 'best_before'),
  ('00000000-0000-0000-0000-0000000e5302', '00000000-0000-0000-0000-0000000e50aa', 'Gold coins', pg_temp.u('g'), 'none');
insert into stock_lot (household_id, product_id, location_id, qty_initial, qty_remaining, due_date) values
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5301', '00000000-0000-0000-0000-0000000e5102', 2000, 2000, pg_temp.today() + 3),
  ('00000000-0000-0000-0000-0000000e50aa', '00000000-0000-0000-0000-0000000e5302', '00000000-0000-0000-0000-0000000e5103', 10, 10, pg_temp.today() + 2);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e5001","role":"authenticated"}';
select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e50aa', 'asset', '00000000-0000-0000-0000-0000000e5202', true)$$,
  'owner marks the gold chain valuable');
select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e50aa', 'asset', '00000000-0000-0000-0000-0000000e5204', true)$$,
  'owner marks the gold watch valuable');
select lives_ok($$select rpc_set_valuable('00000000-0000-0000-0000-0000000e50aa', 'location', '00000000-0000-0000-0000-0000000e5103', true)$$,
  'owner marks the safe valuable');

-- ── Spending ──────────────────────────────────────────────────────────────────
select is((select r -> 'match' ->> 'kind' || ' ' || (r -> 'match' ->> 'name') || ' ' || (r ->> 'total') || ' ' || (r ->> 'bills')
             from (select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-06-01', '2026-07-31') r) x),
  'sub Fish & seafood 4200.00 2', '"fish since June": the Fish & seafood sub-category, Rs 4,200 on 2 bills');
select ok((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-06-01', '2026-07-31') -> 'match' -> 'also'
             @> '[{"kind": "words", "name": "fish"}]'),
  'other readings are offered (words on bill lines)');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'Keells Super', '2026-05-01', '2026-07-31', null, 'shop') ->> 'total'),
  '2500.00', 'a tapped shop re-runs without the AI: Keells Super Rs 2,500');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'tuna', '2026-01-01', '2026-12-31', null, 'words') ->> 'total'),
  '3000.00', 'words printed on bill lines: TUNA Rs 3,000');
select is((select r ->> 'total' || ' ' || (r -> 'groups' -> 0 ->> 'name') || ' ' || (r -> 'groups' -> 0 ->> 'total')
             from (select ask_spend('00000000-0000-0000-0000-0000000e50aa', null, '2026-05-01', '2026-07-31', 'category') r) x),
  '8000.00 Fish & seafood 4700.00', 'all spending May–July Rs 8,000, biggest group Fish & seafood Rs 4,700');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', null, '2026-07-01', '2026-07-31', 'shop') -> 'groups' -> 0 ->> 'name'),
  'Negombo Fish', 'grouped by shop');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'grocery', '2026-06-01', '2026-07-31') ->> 'total'),
  '5000.00', 'a main category includes its sub-categories (Grocery Rs 5,000)');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'zzqx', '2026-06-01', '2026-07-31') ->> 'total'),
  '0', 'nothing by that name: Rs 0, said as such');
select is((select r -> 'match' ->> 'kind' || ' ' || (r ->> 'total') || ' ' || (r ->> 'bills')
             from (select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'cargills', '2026-08-01', '2026-08-31') r) x),
  'shop 300.00 2', '"cargills" counts every shop name with that word (CARGILLS - KURANA and Cargills Food City)');
select is((select r -> 'match' ->> 'name' || ' ' || (r ->> 'total')
             from (select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'subscription', '2026-08-01', '2026-08-31') r) x),
  'Subscriptions 7000.00', 'a category beats a shop whose name contains the word');
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'milk', '2026-08-01', '2026-08-31') -> 'match' ->> 'name'),
  'Dairy & milk', 'two categories match "milk": the one with spending wins');
select is((select ask_find('00000000-0000-0000-0000-0000000e50aa', 'bosch drill tool') -> 'rows' -> 0 ->> 'name'),
  'Bosch drill', 'words are matched one by one (2 of 3 words is enough)');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2019-12-31', '2020-02-01')$$,
  '22023', null, 'dates before 2020 are refused');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2020-01-01', '2026-01-01')$$,
  '22023', null, 'more than 3 years at once is refused');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-07-01', '2026-06-01')$$,
  '22023', null, 'from after to is refused');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', repeat('x', 61))$$, '22023', null, 'about is at most 60 characters');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', null, null, 'evil')$$, '22023', null, 'unknown groups are refused');
select throws_ok($$select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', null, null, null, 'sql')$$, '22023', null, 'unknown kinds are refused');

-- ── Bills behind a total ──────────────────────────────────────────────────────
select is((select r ->> 'count' || ' ' || (r -> 'rows' -> 0 ->> 'payee') || ' ' || (r -> 'rows' -> 0 ->> 'amount')
             from (select ask_transactions('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-06-01', '2026-07-31', 5) r) x),
  '2 Negombo Fish 3000.00', 'the fish bills, newest first, with the fish amount of each');
select throws_ok($$select ask_transactions('00000000-0000-0000-0000-0000000e50aa', 'fish', null, null, 11)$$, '22023', null, 'at most 10 rows');

-- ── What's due ────────────────────────────────────────────────────────────────
select is((select r ->> 'count' || ' ' || (r ->> 'total') || ' ' || (r -> 'rows' -> 0 ->> 'name') || ' ' || (r -> 'rows' -> 1 ->> 'name')
             from (select ask_due('00000000-0000-0000-0000-0000000e50aa', '2027-03-01', '2027-03-31') r) x),
  '2 7570.72 CEB Toyota', 'March 2027: the CEB bill (5th) and the last Toyota instalment (9th)');
select is((select r ->> 'count' || ' ' || (r -> 'rows' -> 0 ->> 'date')
             from (select ask_due('00000000-0000-0000-0000-0000000e50aa', '2027-04-01', '2027-05-31') r) x),
  '2 2027-04-05', 'after the plan ends: the monthly bill in April and May, not the finished plan');

select is((select e ->> 'name' || ' ' || (e ->> 'overdue') from jsonb_array_elements(
             ask_due('00000000-0000-0000-0000-0000000e50aa') -> 'rows') e where e ->> 'kind' = 'bill'),
  'Water true', '"What''s due this month?" includes an unpaid bill from 10 days ago, marked overdue');

-- ── Instalments ───────────────────────────────────────────────────────────────
select is((select (r -> 'rows' -> 0 ->> 'name') || ' ' || (r -> 'rows' -> 0 ->> 'last_on') || ' '
                  || ((r -> 'rows' -> 0 ->> 'paid')::int + (r -> 'rows' -> 0 ->> 'left')::int)
             from (select ask_instalments('00000000-0000-0000-0000-0000000e50aa', 'toyota') r) x),
  'Toyota 2027-03-09 12', '"When does the Toyota instalment end?" 9 Mar 2027 (paid + left = 12)');
select is((select ask_instalments('00000000-0000-0000-0000-0000000e50aa', 'toyota') -> 'rows' -> 0 ->> 'next_on'),
  (select private.instalment_date('2026-04-09', (ask_instalments('00000000-0000-0000-0000-0000000e50aa', 'toyota') -> 'rows' -> 0 ->> 'paid')::int + 1)::text),
  'the next instalment is the one after those paid');
select is((select jsonb_array_length(ask_instalments('00000000-0000-0000-0000-0000000e50aa', 'mortgage') -> 'rows')), 0,
  'no such plan: no rows');

-- ── Where is it? ──────────────────────────────────────────────────────────────
select is((select (r -> 'rows' -> 0 ->> 'kind') || ' ' || (r -> 'rows' -> 0 ->> 'name') || ' ' || (r -> 'rows' -> 0 ->> 'place')
             from (select ask_find('00000000-0000-0000-0000-0000000e50aa', 'drill') r) x),
  'thing Bosch drill Garage', '"Where is the drill?" Garage');
select ok(not (ask_find('00000000-0000-0000-0000-0000000e50aa', 'drill')::text ilike '%Spare drill%'),
  'a drill inside the safe is never shown, even to the owner');
select ok(not ((ask_find('00000000-0000-0000-0000-0000000e50aa', 'gold chain') -> 'rows')::text ilike '%Gold chain%'),
  'a valuable thing is never shown, even to the owner');
select is((select jsonb_array_length(ask_find('00000000-0000-0000-0000-0000000e50aa', 'safe') -> 'rows')), 0,
  'a valuable place is never shown, even to the owner');
select is((select (r -> 'rows' -> 0 ->> 'qty') || ' ' || (r -> 'rows' -> 0 ->> 'unit') || ' ' || (r -> 'rows' -> 0 ->> 'place')
             from (select ask_find('00000000-0000-0000-0000-0000000e50aa', 'basmati') r) x),
  '2000.0000 g Kitchen', 'a product: how much and where');
select is((select jsonb_array_length(ask_find('00000000-0000-0000-0000-0000000e50aa', 'gold coins') -> 'rows')), 1,
  'a product whose only stock is in the safe is found …');
select is((select ask_find('00000000-0000-0000-0000-0000000e50aa', 'gold coins') -> 'rows' -> 0 ->> 'place'), null,
  '… but without its place or amount there');
select throws_ok($$select ask_find('00000000-0000-0000-0000-0000000e50aa', null)$$, '22023', null, 'find needs words');

-- ── Pantry ────────────────────────────────────────────────────────────────────
select is((select string_agg(e ->> 'name', ',') from jsonb_array_elements(
             ask_pantry('00000000-0000-0000-0000-0000000e50aa', 'expiring', 7) -> 'rows') e),
  'Basmati rice', 'expiring this week: the rice, not the coins in the safe');
select throws_ok($$select ask_pantry('00000000-0000-0000-0000-0000000e50aa', 'all', 7)$$, '22023', null, 'unknown pantry views are refused');
select throws_ok($$select ask_pantry('00000000-0000-0000-0000-0000000e50aa', 'expiring', 61)$$, '22023', null, 'at most 60 days ahead');

-- ── Balances ──────────────────────────────────────────────────────────────────
select is((select (r -> 'rows' -> 0 ->> 'name') || ' ' || (r -> 'rows' -> 0 ->> 'last4') || ' ' || (r -> 'rows' -> 0 ->> 'balance')
             from (select ask_balances('00000000-0000-0000-0000-0000000e50aa', 'BOC') r) x),
  'BOC Savings 319 237010.25', '"How much is in BOC?" name, last digits, balance');
select is((select (r ->> 'balance') || ' ' || (r ->> 'available') from jsonb_array_elements(
             ask_balances('00000000-0000-0000-0000-0000000e50aa', null) -> 'rows') r where r ->> 'name' = 'Seylan card'),
  '-2500.00 97500.00', 'a card: owed (negative) and available credit');

-- ── Budget, warranties ────────────────────────────────────────────────────────
select is((select (r -> 'rows' -> 0 ->> 'name') || ' ' || (r -> 'rows' -> 0 ->> 'spent') || ' ' || (r -> 'rows' -> 0 ->> 'left')
             from (select ask_budget('00000000-0000-0000-0000-0000000e50aa', '2026-07-01') r) x),
  'Grocery 3000.00 2000.00', 'July: Grocery Rs 3,000 of Rs 5,000, Rs 2,000 left');
select is((select string_agg(e ->> 'name', ',') from jsonb_array_elements(
             ask_warranty('00000000-0000-0000-0000-0000000e50aa', 60) -> 'rows') e),
  'TV', 'warranties ending: the TV, not the valuable watch or anything in the safe');

-- ── A viewer may ask ──────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e5003","role":"authenticated"}';
select is((select ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-06-01', '2026-07-31') ->> 'total'), '4200.00',
  'a viewer gets the same answer');

-- ── Household B gets nothing of A ─────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000e6001","role":"authenticated"}';
select ok(ask_spend('00000000-0000-0000-0000-0000000e50aa', 'fish', '2026-06-01', '2026-07-31') is null
      and ask_transactions('00000000-0000-0000-0000-0000000e50aa', 'fish') is null
      and ask_due('00000000-0000-0000-0000-0000000e50aa') is null
      and ask_instalments('00000000-0000-0000-0000-0000000e50aa') is null
      and ask_find('00000000-0000-0000-0000-0000000e50aa', 'drill') is null
      and ask_pantry('00000000-0000-0000-0000-0000000e50aa', 'expiring') is null
      and ask_balances('00000000-0000-0000-0000-0000000e50aa') is null
      and ask_budget('00000000-0000-0000-0000-0000000e50aa') is null
      and ask_warranty('00000000-0000-0000-0000-0000000e50aa') is null,
  'every ask_* function returns null for another household');
select is((select ask_spend('00000000-0000-0000-0000-0000000e60bb', 'fish', '2026-06-01', '2026-07-31') ->> 'total'), '9999.00',
  'B sees only its own fish');

-- ── Static checks ─────────────────────────────────────────────────────────────
reset role;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'ask\_%'), 9, 'exactly 9 ask_* functions');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where ((n.nspname = 'public' and p.proname like 'ask\_%')
                              or (n.nspname = 'private' and (p.proname like 'ask\_%' or p.proname = 'instalment_date')))
                         and p.prosecdef),
  'no ask function is SECURITY DEFINER (RLS always applies)');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname like 'ask\_%'
                         and (has_function_privilege('anon', p.oid, 'execute') or p.provolatile <> 's')),
  'no ask_* is callable by anon, and all are stable (read-only)');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where ((n.nspname = 'public' and p.proname like 'ask\_%')
                              or (n.nspname = 'private' and p.proname like 'ask\_%'))
                         and p.prosrc ~* '(home_|sms_|_token|push_|auth\.|asset_place_private|attachment|activity|scan_|household_member|invite|storage\.|insert |update |delete )'),
  'no ask function reads SMS, the house, tokens, members, files, or writes anything');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname like 'ask\_%'
                         and not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')),
  'every ask_* pins search_path');

select * from finish();
rollback;
