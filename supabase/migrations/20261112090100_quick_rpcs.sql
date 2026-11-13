-- Phase 12 · 112 — Quick spend RPCs
--
-- rpc_quick_setup(household)       first open: the caller's cash wallet + starter tiles (idempotent).
-- rpc_quick_state(household)       everything the screen shows, in one read.
-- rpc_quick_spend(household, ops)  one entry or a small batch (≤ 50) in ONE request (log budget).
--   Every op carries the id it got on the phone when the tile was tapped. An id seen before returns
--   the first result (`replayed`) and writes nothing, so a retry, a replay after a reload, two tabs
--   or two phones never count an entry twice. Each op runs on its own: one that the database
--   refuses is reported as `refused` and the others still go through, in the order given.
--   The money is written by private.save_transaction (rule 1) as the signed-in person; viewers are
--   refused by private.can_write.
--   Fingerprints stay deterministic (rule 5): the phone sends the manual-entry fingerprint
--   m<djb2(type|date|time|account|payee|total)> of the tap; two genuine entries that collide
--   (same tile, amount and second) get ~2, ~3 … exactly like "save another" in the expense form.
-- Error codes: 42501 not allowed · 23514 bad shape · GDQAM amount out of range · GDQWL no wallet yet

-- ── rpc_quick_setup ───────────────────────────────────────────────────────────
create function public.rpc_quick_setup(p_household uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_tz      text;
  v_first   text;
  v_name    text;
  v_account uuid;
  v_wallet  boolean := false;
  v_tiles   integer := 0;
  r         record;
  v_cat     uuid;
begin
  if v_uid is null or p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Two devices opening Quick spend for the first time at once: one waits, then finds it done.
  perform pg_advisory_xact_lock(hashtextextended('quick_setup:' || p_household::text, 0));

  if not exists (select 1 from public.quick_prefs q where q.household_id = p_household and q.user_id = v_uid) then
    select h.timezone into v_tz from public.household h where h.id = p_household;
    select nullif(split_part(btrim(coalesce(m.display_name, '')), ' ', 1), '') into v_first
      from public.household_member m where m.household_id = p_household and m.user_id = v_uid;

    -- The owner keeps the household's existing cash account (and its history) as their wallet.
    if private.is_owner(p_household) then
      select a.id, a.name into v_account, v_name from public.account a
       where a.household_id = p_household and a.kind = 'cash' and not a.archived and not a.is_suspense
         and not exists (select 1 from public.quick_prefs q
                          where q.household_id = p_household and q.cash_account_id = a.id)
       order by a.created_at, a.sort, a.id
       limit 1;
      if v_account is not null and v_first is not null and lower(btrim(v_name)) = 'cash'
         and not exists (select 1 from public.account a
                          where a.household_id = p_household and lower(btrim(a.name)) = lower('Cash — ' || v_first)) then
        update public.account set name = left('Cash — ' || v_first, 60) where id = v_account;
      end if;
    end if;

    if v_account is null then
      v_name := left('Cash — ' || coalesce(v_first, 'me'), 60);
      select a.id into v_account from public.account a
       where a.household_id = p_household and lower(btrim(a.name)) = lower(v_name) and a.kind = 'cash'
         and not exists (select 1 from public.quick_prefs q
                          where q.household_id = p_household and q.cash_account_id = a.id);
      if v_account is null then
        if exists (select 1 from public.account a
                    where a.household_id = p_household and lower(btrim(a.name)) = lower(v_name)) then
          v_name := left(v_name, 51) || ' ' || left(v_uid::text, 8);
        end if;
        -- A new wallet starts at Rs 0 as of yesterday evening (a balance counts entries AFTER its
        -- opening day, so today's count); the cash check or Reconcile sets what is really in it.
        insert into public.account (household_id, name, kind, opening_balance, opening_on, color, sort)
        values (p_household, v_name, 'cash', 0, (now() at time zone coalesce(v_tz, 'Asia/Colombo'))::date - 1, '#2FC6A0',
                (select coalesce(max(a.sort), 0) + 1 from public.account a where a.household_id = p_household))
        returning id into v_account;
      end if;
    end if;

    insert into public.quick_prefs (household_id, user_id, cash_account_id)
    values (p_household, v_uid, v_account);
    v_wallet := true;
  end if;

  if not exists (select 1 from public.quick_tile t where t.household_id = p_household and t.user_id = v_uid) then
    for r in
      select * from (values
        (1,  'tuk',        '🛺', 'expense',  'transport',  'Taxi / PickMe / Uber',  false),
        (2,  'bus',        '🚌', 'expense',  'transport',  'Bus & train',           false),
        (3,  'tea',        '☕', 'expense',  'dining',     'Tea shop / snacks',     false),
        (4,  'short_eats', '🥟', 'expense',  'dining',     'Tea shop / snacks',     false),
        (5,  'meal',       '🍛', 'expense',  'dining',     'Canteen / office',      false),
        (6,  'petrol',     '⛽', 'expense',  'energy',     'Petrol',                false),
        (7,  'vendor',     '🧺', 'expense',  'grocery',    'Other grocery',         false),
        (8,  'parking',    '🅿️', 'expense',  'transport',  'Parking & tolls',       false),
        (9,  'other',      '📎', 'expense',  'other',      'Miscellaneous',         false),
        (10, 'train',      '🚆', 'expense',  'transport',  'Bus & train',           true),
        (11, 'water',      '💧', 'expense',  'water',      'Bottled water',         true),
        (12, 'pharmacy',   '💊', 'expense',  'consumable', 'Medicine & pharmacy',   true),
        (13, 'donation',   '🙏', 'expense',  'other',      'Charity & donations',   true),
        (14, 'gave',       '🤝', 'handover', null,         null,                    true)
      ) as t (sort, key, icon, kind, top, sub, hidden)
    loop
      -- Our real categories: the sub-category by name under its seeded top level, else the top level.
      v_cat := null;
      if r.top is not null then
        select coalesce(
          (select c.id from public.category c
            where c.household_id = p_household and c.parent_id = p.id and not c.archived
              and lower(btrim(c.name)) = lower(r.sub) limit 1),
          p.id) into v_cat
          from public.category p
         where p.household_id = p_household and p.key = r.top;
      end if;
      insert into public.quick_tile (household_id, user_id, key, icon, kind, category_id, sort, hidden)
      values (p_household, v_uid, r.key, r.icon, r.kind, v_cat, r.sort, r.hidden)
      on conflict (household_id, user_id, key) do nothing;
      v_tiles := v_tiles + 1;
    end loop;
  end if;

  return jsonb_build_object('wallet_created', v_wallet, 'tiles_created', v_tiles);
end;
$$;

-- ── rpc_quick_state ───────────────────────────────────────────────────────────
-- Everything the Quick spend screen needs, in ONE read (log budget): the caller's settings, wallet
-- and its balance, tiles, the accounts an entry can be paid from, the other people's wallets
-- (hand-overs), their own entries of the last 60 days (tile learning + today's list) and how many
-- cash entries were made since the last cash check. Runs as the caller: RLS decides what is seen.
create function public.rpc_quick_state(p_household uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when not private.is_member(p_household) then null else jsonb_build_object(
    'prefs', (select to_jsonb(q) - 'created_at' - 'updated_at' from public.quick_prefs q
               where q.household_id = p_household and q.user_id = (select auth.uid())),
    'balance', (select b.balance from public.v_account_balance b
                  join public.quick_prefs q on q.cash_account_id = b.account_id
                 where q.household_id = p_household and q.user_id = (select auth.uid())),
    'tiles', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'key', t.key, 'label', t.label, 'icon', t.icon, 'kind', t.kind,
                 'category_id', t.category_id, 'usual_amount', t.usual_amount, 'sort', t.sort, 'hidden', t.hidden)
                 order by t.sort, t.created_at, t.id)
               from public.quick_tile t
              where t.household_id = p_household and t.user_id = (select auth.uid())), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind)
                 order by a.sort, a.name)
               from public.account a
              where a.household_id = p_household and not a.archived and not a.is_suspense
                and a.kind in ('cash', 'bank', 'wallet', 'credit_card')), '[]'::jsonb),
    'wallets', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', q.user_id, 'account_id', q.cash_account_id, 'name', a.name,
                 'person', nullif(split_part(btrim(coalesce(m.display_name, '')), ' ', 1), ''))
                 order by a.name)
               from public.quick_prefs q
               join public.account a on a.id = q.cash_account_id and a.household_id = q.household_id
               left join public.household_member m on m.household_id = q.household_id and m.user_id = q.user_id
              where q.household_id = p_household and q.user_id <> (select auth.uid())), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(x.e order by x.client_at desc) from (
                 select e.client_at, jsonb_build_object(
                          'op_id', e.op_id, 'tile_id', e.tile_id, 'kind', e.kind, 'client_at', e.client_at,
                          'id', t.id, 'amount', coalesce(t.total, e.amount), 'account_id', t.account_id,
                          'occurred_on', t.occurred_on, 'occurred_at', t.occurred_at, 'notes', t.notes,
                          'label', (select l.raw_name from public.transaction_line l
                                     where l.transaction_id = t.id order by l.line_no limit 1),
                          'category_id', (select l.category_id from public.transaction_line l
                                           where l.transaction_id = t.id order by l.line_no limit 1)) as e
                   from public.quick_entry e
                   left join public.money_transaction t on t.id = e.transaction_id and t.household_id = e.household_id
                  where e.household_id = p_household and e.actor = (select auth.uid())
                    and e.client_at > now() - interval '60 days'
                  order by e.client_at desc
                  limit 600) x), '[]'::jsonb),
    'since_check', (select count(*) from public.quick_entry e
                      join public.quick_prefs q on q.household_id = e.household_id and q.user_id = e.actor
                      join public.money_transaction t on t.id = e.transaction_id and t.account_id = q.cash_account_id
                     where e.household_id = p_household and e.actor = (select auth.uid())
                       and (q.cash_checked_on is null or t.occurred_on > q.cash_checked_on))
  ) end;
$$;

-- ── rpc_quick_spend ───────────────────────────────────────────────────────────
-- p_ops: [{ op_id, kind? ('expense' | 'handover'), tile_id?, label, category_id?, amount,
--           account_id?, to_account_id? (handover), client_at, fingerprint, line_tail?, note? }]
-- Returns [{ op_id, status: 'saved' | 'replayed' | 'refused', id?, fingerprint?, code?, message? }].
create function public.rpc_quick_spend(p_household uuid, p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_tz      text;
  v_wallet  uuid;
  v_out     jsonb := '[]'::jsonb;
  v_op      jsonb;
  v_op_id   uuid;
  v_tx      uuid;
  v_kind    text;
  v_amount  numeric;
  v_at      timestamptz;
  v_local   timestamp;
  v_account uuid;
  v_to      uuid;
  v_fp      text;
  v_try     text;
  v_tail    text;
  v_label   text;
  v_tile    uuid;
  v_saved   jsonb;
  v_n       integer;
  v_code    text;
  v_msg     text;
begin
  if v_uid is null or p_household is null or not private.can_write(p_household) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) not between 1 and 50 then
    raise exception 'ops must be an array of 1 to 50' using errcode = '23514';
  end if;

  select h.timezone into v_tz from public.household h where h.id = p_household;
  select q.cash_account_id into v_wallet from public.quick_prefs q
   where q.household_id = p_household and q.user_id = v_uid;

  for v_op in select value from jsonb_array_elements(p_ops) loop
    begin
      v_op_id := (v_op ->> 'op_id')::uuid;
      if v_op_id is null then
        raise exception 'op_id is required' using errcode = '23514';
      end if;
      -- The same op from two devices at the same moment: the second waits, then finds the first.
      perform pg_advisory_xact_lock(hashtextextended(p_household::text || ':quick:' || v_op_id::text, 0));

      select e.transaction_id into v_tx from public.quick_entry e
       where e.household_id = p_household and e.op_id = v_op_id;
      if found then
        v_out := v_out || jsonb_build_object('op_id', v_op_id, 'status', 'replayed', 'id', v_tx);
        continue;
      end if;

      v_kind := coalesce(v_op ->> 'kind', 'expense');
      if v_kind not in ('expense', 'handover') then
        raise exception 'unknown kind' using errcode = '23514';
      end if;
      v_amount := round((v_op ->> 'amount')::numeric, 2);
      if v_amount is null or v_amount <= 0 or v_amount > 200000 then
        raise exception 'amount out of range' using errcode = 'GDQAM';
      end if;
      -- When it was tapped, never in the future (a phone with a wrong clock).
      v_at := least((v_op ->> 'client_at')::timestamptz, now());
      if v_at is null then
        raise exception 'client_at is required' using errcode = '23514';
      end if;
      v_local := v_at at time zone coalesce(v_tz, 'Asia/Colombo');
      v_account := coalesce((v_op ->> 'account_id')::uuid, v_wallet);
      if v_account is null then
        raise exception 'no wallet yet' using errcode = 'GDQWL';
      end if;
      v_to := (v_op ->> 'to_account_id')::uuid;
      if (v_kind = 'handover') <> (v_to is not null) then
        raise exception 'a hand-over needs the other wallet' using errcode = '23514';
      end if;
      v_fp := v_op ->> 'fingerprint';
      v_tail := v_op ->> 'line_tail';
      if v_fp is null or v_fp !~ '^m[0-9a-z]{1,13}$'
         or (v_kind = 'expense' and (v_tail is null or v_tail !~ '^[0-9a-z]{1,13}$')) then
        raise exception 'bad fingerprint' using errcode = '23514';
      end if;
      v_label := left(coalesce(nullif(btrim(v_op ->> 'label'), ''), 'Quick spend'), 60);

      v_n := 1;
      loop
        v_try := v_fp || case when v_n > 1 then '~' || v_n else '' end;
        begin
          v_saved := private.save_transaction(jsonb_build_object(
            'household_id', p_household,
            'type', case v_kind when 'handover' then 'transfer' else 'expense' end,
            'account_id', v_account,
            'to_account_id', v_to,
            'occurred_on', v_local::date,
            'occurred_at', to_char(v_local, 'HH24:MI:SS'),
            'total', v_amount,
            'fingerprint', v_try,
            'notes', left(nullif(btrim(v_op ->> 'note'), ''), 500),
            'lines', case v_kind when 'handover' then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
              'raw_name', v_label,
              'category_id', v_op ->> 'category_id',
              'amount', v_amount,
              -- Never pantry stock, whatever the category's default (Vendor → Grocery).
              'destiny', 'expense',
              'fingerprint', v_try || '-0-' || v_tail)) end
          ), 'manual');
          exit;
        exception when sqlstate 'GDDUP' then
          if v_n >= 50 then
            raise;
          end if;
          v_n := v_n + 1;
        end;
      end loop;
      v_tx := (v_saved ->> 'id')::uuid;

      -- A tile deleted since the tap must not refuse the entry.
      select t.id into v_tile from public.quick_tile t
       where t.household_id = p_household and t.id = (v_op ->> 'tile_id')::uuid;

      insert into public.quick_entry (household_id, op_id, transaction_id, tile_id, kind, amount, client_at, actor)
      values (p_household, v_op_id, v_tx, v_tile, v_kind, v_amount, v_at, v_uid);

      v_out := v_out || jsonb_build_object('op_id', v_op_id, 'status', 'saved', 'id', v_tx, 'fingerprint', v_try);
    exception when others then
      get stacked diagnostics v_code = returned_sqlstate, v_msg = message_text;
      v_out := v_out || jsonb_build_object('op_id', v_op ->> 'op_id', 'status', 'refused', 'code', v_code, 'message', v_msg);
    end;
  end loop;

  return v_out;
end;
$$;

revoke execute on function public.rpc_quick_setup(uuid) from public, anon;
revoke execute on function public.rpc_quick_state(uuid) from public, anon;
revoke execute on function public.rpc_quick_spend(uuid, jsonb) from public, anon;
grant execute on function public.rpc_quick_setup(uuid) to authenticated;
grant execute on function public.rpc_quick_state(uuid) to authenticated;
grant execute on function public.rpc_quick_spend(uuid, jsonb) to authenticated;

update public.app_meta set value = '112' where key = 'schema_version';
