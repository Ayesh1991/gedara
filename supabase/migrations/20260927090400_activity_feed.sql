-- Phase 6 · 44 — the activity timeline covers the whole house (MASTER_PLAN §3.7, §5.2 Home)
-- Phase 5 wrote asset events only. Now triggers also record:
--   transaction  created (payee, type, total) · deleted (its earlier entries go, one 'deleted' stays)
--   stock        one row per user action (correlation): purchase / consume / waste / open / moved /
--                inventory / edit / undo, merged across the action's movements (a bill → 8 lots = 1 row)
--   maintenance  logged (payload has the asset) — the asset page already shows logs, so it stays
--                entity_type 'maintenance' and never duplicates the asset timeline
--   product, location  created
-- Still append-only for clients (read-only; written by SECURITY DEFINER triggers).

-- One row per stock action: the upsert target.
create unique index activity_stock_action_idx on public.activity (household_id, entity_id, verb)
  where entity_type = 'stock';

-- ── Transactions ──────────────────────────────────────────────────────────────
create function private.money_transaction_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.related_id is not null then
      return null;  -- a transfer's fee belongs to the transfer
    end if;
    insert into public.activity (household_id, actor, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, new.created_by, 'transaction', new.id, 'created',
            left(coalesce(new.payee_text, new.type), 200),
            jsonb_build_object('type', new.type, 'total', new.total, 'source', new.source,
                               'occurred_on', new.occurred_on, 'account_id', new.account_id));
    return null;
  end if;

  delete from public.activity a
   where a.household_id = old.household_id and a.entity_type = 'transaction' and a.entity_id = old.id;
  if old.related_id is null and exists (select 1 from public.household h where h.id = old.household_id) then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (old.household_id, 'transaction', old.id, 'deleted', left(coalesce(old.payee_text, old.type), 200),
            jsonb_build_object('type', old.type, 'total', old.total, 'occurred_on', old.occurred_on));
  end if;
  return null;
end;
$$;

create trigger money_transaction_activity
  after insert or delete on public.money_transaction
  for each row execute function private.money_transaction_activity();

-- ── Stock actions ─────────────────────────────────────────────────────────────
-- payload: { product_ids: [...], product_id (first), qty (only while one product), unit, value }
create function private.stock_movement_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verb  text;
  v_name  text;
  v_unit  text;
  v_value numeric := round(abs(new.delta) * coalesce(new.unit_cost, 0), 2);
begin
  if new.reason = 'transfer_in' then
    return null;  -- transfer_out already describes the move
  end if;
  v_verb := case new.reason
              when 'transfer_out' then 'moved'
              when 'adjust' then 'inventory'
              else new.reason
            end;
  select p.name, u.code into v_name, v_unit
    from public.product p join public.unit u on u.id = p.stock_unit_id
   where p.id = new.product_id;

  insert into public.activity (household_id, actor, at, entity_type, entity_id, verb, summary, payload)
  values (new.household_id, new.actor, new.created_at, 'stock', new.correlation_id, v_verb, left(v_name, 200),
          jsonb_build_object('product_ids', jsonb_build_array(new.product_id), 'product_id', new.product_id,
                             'qty', abs(new.delta), 'unit', v_unit, 'value', v_value))
  on conflict (household_id, entity_id, verb) where entity_type = 'stock'
  do update set payload =
    case when public.activity.payload -> 'product_ids' @> to_jsonb(array[new.product_id::text])
         then jsonb_set(jsonb_set(public.activity.payload, '{qty}',
                          to_jsonb(coalesce((public.activity.payload ->> 'qty')::numeric, 0) + abs(new.delta))),
                        '{value}', to_jsonb(coalesce((public.activity.payload ->> 'value')::numeric, 0) + v_value))
         else jsonb_set(jsonb_set(jsonb_set(public.activity.payload, '{product_ids}',
                          (public.activity.payload -> 'product_ids') || to_jsonb(new.product_id)),
                        '{qty}', 'null'::jsonb),
                        '{value}', to_jsonb(coalesce((public.activity.payload ->> 'value')::numeric, 0) + v_value))
    end;
  return null;
end;
$$;

create trigger stock_movement_activity
  after insert on public.stock_movement
  for each row execute function private.stock_movement_activity();

-- ── Maintenance logs ──────────────────────────────────────────────────────────
create function private.maintenance_log_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity (household_id, actor, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, new.created_by, 'maintenance', new.id, 'logged', left(new.title, 200),
            jsonb_build_object('asset_id', new.asset_id, 'cost', new.cost, 'done_on', new.done_on));
  else
    delete from public.activity a
     where a.household_id = old.household_id and a.entity_type = 'maintenance' and a.entity_id = old.id;
  end if;
  return null;
end;
$$;

create trigger maintenance_log_activity
  after insert or delete on public.maintenance_log
  for each row execute function private.maintenance_log_activity();

-- ── Products and places ───────────────────────────────────────────────────────
create function private.entity_created_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity (household_id, entity_type, entity_id, verb, summary, payload)
    values (new.household_id, tg_argv[0], new.id, 'created', left(new.name, 200), '{}'::jsonb);
  else
    delete from public.activity a
     where a.household_id = old.household_id and a.entity_type = tg_argv[0] and a.entity_id = old.id;
  end if;
  return null;
end;
$$;

create trigger product_activity
  after insert or delete on public.product
  for each row execute function private.entity_created_activity('product');

create trigger location_activity
  after insert or delete on public.location
  for each row execute function private.entity_created_activity('location');

-- ── v_activity: with who did it ───────────────────────────────────────────────
create view public.v_activity
with (security_invoker = true) as
  select a.id, a.household_id, a.at, a.actor, hm.display_name as actor_name,
         a.entity_type, a.entity_id, a.verb, a.summary, a.payload
    from public.activity a
    left join public.household_member hm on hm.household_id = a.household_id and hm.user_id = a.actor;

revoke all on public.v_activity from anon, authenticated;
grant select on public.v_activity to authenticated;

update public.app_meta set value = '44' where key = 'schema_version';
