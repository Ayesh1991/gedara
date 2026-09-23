-- Phase 1 · 7 — HL:<KIND>:<6-char Crockford base32> label codes (MASTER_PLAN §3.8, §7c)
-- Codes are printed on physical labels, so they are generated once by the database, unique across
-- every household (a label scanned in the wrong house must never open someone else's box), and
-- never change. Only UPPERCASE Crockford characters: keeps a 13-char code in QR alphanumeric mode
-- (version 1-M fits on a 20 mm NIIMBOT label).

create extension if not exists pgcrypto with schema extensions;

-- Crockford base32: 0-9 A-Z without I, L, O, U. 256 is a multiple of 32, so byte % 32 is unbiased.
create function private.crockford_code(p_len integer)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(p_len);
  v_out text := '';
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- New unique code for a table with a `code` column. SECURITY DEFINER so the uniqueness check sees
-- every household's rows (RLS would hide them from the caller). Called only from triggers.
create function private.new_hl_code(p_prefix text, p_table regclass)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_taken boolean;
begin
  if p_prefix !~ '^[A-Z]{3}$' then
    raise exception 'bad HL code prefix: %', p_prefix using errcode = '22023';
  end if;
  for attempt in 1 .. 20 loop
    v_code := 'HL:' || p_prefix || ':' || private.crockford_code(6);
    execute format('select exists (select 1 from %s where code = $1)', p_table) into v_taken using v_code;
    if not v_taken then
      return v_code;
    end if;
  end loop;
  raise exception 'could not allocate a unique % code', p_prefix;
end;
$$;

revoke execute on function private.crockford_code(integer) from public, anon, authenticated;
revoke execute on function private.new_hl_code(text, regclass) from public, anon, authenticated;

-- Shared updated_at stamp for every mutable table from here on.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

update public.app_meta set value = '7' where key = 'schema_version';
