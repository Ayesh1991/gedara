-- Fix · 104 — deleting an account no longer fails on a shop memory that only knew that account.
--
-- merchant_memory (79) keeps a category and/or a usual account and requires at least one of them.
-- Its account foreign key is ON DELETE SET NULL (account_id), so a row that remembered only the account
-- ("this shop is paid by the Seylan card", no category) became (null, null) when the account was deleted,
-- and the check stopped the delete with 23514 merchant_memory_check. A row that also has a category keeps
-- it, as before. The memory is useless without the account, so it is forgotten just before the account
-- goes; the foreign key still clears account_id on rows that keep their category.

create function private.account_forget_merchant_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.merchant_memory m
   where m.household_id = old.household_id
     and m.account_id = old.id
     and m.category_id is null;
  return old;
end;
$$;

revoke execute on function private.account_forget_merchant_memory() from public, anon, authenticated;

create trigger account_forget_merchant_memory
  before delete on public.account
  for each row execute function private.account_forget_merchant_memory();

update public.app_meta set value = '104' where key = 'schema_version';
