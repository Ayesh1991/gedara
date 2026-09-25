-- Phase 5 · 38 — category defaults for Things (data only; decided with Didula 2026-09-25)
-- 1. Clothing, Footwear and Gifts are not tracked as things by default: their bill lines are
--    "expense only" from now on, and existing Things lines in those categories that nobody has
--    entered yet leave the "Bought, not entered yet" queue. (A single line can still be sent to
--    Things by hand.)
-- 2. Income › "Sale of belongings" for the income that selling a thing creates.

update public.category c
   set default_destiny = 'expense'
  from public.category p
 where p.id = c.parent_id and p.household_id = c.household_id and p.key = 'nonconsumable'
   and lower(c.name) in ('clothing', 'footwear', 'gifts')
   and c.default_destiny = 'asset';

update public.transaction_line l
   set destiny = 'expense'
  from public.category c
  join public.category p on p.id = c.parent_id and p.household_id = c.household_id and p.key = 'nonconsumable'
 where c.id = l.category_id and c.household_id = l.household_id
   and lower(c.name) in ('clothing', 'footwear', 'gifts')
   and l.destiny = 'asset'
   and not exists (select 1 from public.asset a where a.household_id = l.household_id and a.transaction_line_id = l.id);

insert into public.category (household_id, parent_id, name, kind, default_destiny, sort)
select p.household_id, p.id, 'Sale of belongings', 'income', 'expense',
       coalesce((select max(s.sort) from public.category s where s.parent_id = p.id), 0) + 1
  from public.category p
 where p.key = 'income'
   and not exists (select 1 from public.category s
                    where s.parent_id = p.id and lower(s.name) = 'sale of belongings');

update public.app_meta set value = '38' where key = 'schema_version';
