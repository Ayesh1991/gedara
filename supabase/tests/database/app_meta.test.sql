-- app_meta: schema_version() is readable by everyone; the table itself is not.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

select is(schema_version(), 17, 'schema_version is 17 after Phase 2');

set local role anon;
select is(schema_version(), 17, 'anon can call schema_version()');
select throws_ok($$select * from app_meta$$, '42501', null, 'anon cannot read app_meta');

reset role;
set local role authenticated;
select throws_ok($$select * from app_meta$$, '42501', null, 'authenticated cannot read app_meta');
select throws_ok($$update app_meta set value = '999'$$, '42501', null, 'authenticated cannot write app_meta');

select * from finish();
rollback;
