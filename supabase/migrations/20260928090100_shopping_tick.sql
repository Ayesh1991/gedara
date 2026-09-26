-- Phase 7 · 51 — shopping-list ticks that can be replayed (offline outbox)
-- A tick queued offline is sent later with the time it was tapped. It only applies when nobody
-- changed the item after that moment (newest change wins), so a stale tick from a phone that was
-- in the lift doesn't undo what the other phone did since. Sending the same tick twice is harmless.
-- Result: 'applied' · 'same' (already like that) · 'stale' (changed since) · 'gone' (deleted).

create function public.rpc_shopping_tick(p_item uuid, p_done boolean, p_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shopping_list_item%rowtype;
begin
  if p_item is null or p_done is null then
    raise exception 'item and done are required' using errcode = '23514';
  end if;

  select * into v from public.shopping_list_item i where i.id = p_item for update;
  if not found or not private.is_member(v.household_id) then
    return 'gone';
  end if;
  if not private.can_write(v.household_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.done = p_done then
    return 'same';
  end if;
  if p_at is not null and v.updated_at > p_at then
    return 'stale';
  end if;

  -- A ticked item can't stay "Not now" (check `not (done and dismissed)`).
  update public.shopping_list_item i
     set done = p_done,
         dismissed = case when p_done then false else i.dismissed end
   where i.id = p_item;
  return 'applied';
end;
$$;

revoke execute on function public.rpc_shopping_tick(uuid, boolean, timestamptz) from public, anon;
grant execute on function public.rpc_shopping_tick(uuid, boolean, timestamptz) to authenticated;

update public.app_meta set value = '51' where key = 'schema_version';
