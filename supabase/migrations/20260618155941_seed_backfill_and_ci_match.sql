-- Fix: the on_auth_user_created trigger only fires on INSERT into
-- auth.users, so any user whose account predates the previous migration
-- never got seeded — their accounts/categories tables are empty, which is
-- why every CSV row and every chat-confirmed write failed to find "Chase".
-- This pulls the seeding logic into a reusable function and backfills it
-- for any user who currently has zero accounts.

create or replace function seed_user_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := p_user_id;
  v_expense_top text[] := array['Business Expenses','Vices','Food/Drinks','Phone','Travel','Gym','Storage','Housing','Apple','Crypto','Lifestyle','Fun','Gift','Laundry','Haircut','Other'];
  v_income_top text[] := array['Temp Work','Odd Jobs','Crypto','Other Income'];
  v_expense_children jsonb := '[
    {"parent":"Vices","children":["Weed","Squares"]},
    {"parent":"Food/Drinks","children":["Beverages","Lunch","Dinner","Breakfast","Eating out","Snacks","Shopping"]},
    {"parent":"Travel","children":["Ventra","Metra"]}
  ]'::jsonb;
  v_income_children jsonb := '[
    {"parent":"Temp Work","children":["Personal Training","Canvassing"]}
  ]'::jsonb;
  v_accounts text[] := array['Chase','Chime','Cash','Venmo','Cashapp','Octopharma','7-Eleven','Temp cards','DoorDash Crimson'];
  v_name text;
  v_group jsonb;
  v_parent_id uuid;
  v_child text;
  v_hint record;
begin
  if exists (select 1 from accounts where user_id = v_user_id) then
    return; -- already seeded, never double-seed
  end if;

  foreach v_name in array v_expense_top loop
    insert into categories (user_id, name, kind) values (v_user_id, v_name, 'expense');
  end loop;
  foreach v_name in array v_income_top loop
    insert into categories (user_id, name, kind) values (v_user_id, v_name, 'income');
  end loop;

  for v_group in select * from jsonb_array_elements(v_expense_children) loop
    select id into v_parent_id from categories
      where user_id = v_user_id and kind = 'expense' and name = v_group->>'parent';
    for v_child in select jsonb_array_elements_text(v_group->'children') loop
      insert into categories (user_id, name, parent_id, kind) values (v_user_id, v_child, v_parent_id, 'expense');
    end loop;
  end loop;

  for v_group in select * from jsonb_array_elements(v_income_children) loop
    select id into v_parent_id from categories
      where user_id = v_user_id and kind = 'income' and name = v_group->>'parent';
    for v_child in select jsonb_array_elements_text(v_group->'children') loop
      insert into categories (user_id, name, parent_id, kind) values (v_user_id, v_child, v_parent_id, 'income');
    end loop;
  end loop;

  foreach v_name in array v_accounts loop
    if v_name = 'Octopharma' then
      insert into accounts (user_id, name, group_type, is_liability) values (v_user_id, v_name, 'card', true);
      continue;
    end if;

    select * into v_hint from account_type_hints
      where lower(v_name) like '%' || pattern || '%'
      order by length(pattern) desc
      limit 1;

    if found then
      insert into accounts (user_id, name, group_type, is_liability) values (v_user_id, v_name, v_hint.group_type, v_hint.is_liability);
    else
      insert into accounts (user_id, name) values (v_user_id, v_name);
    end if;
  end loop;
end;
$$;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_user_data(new.id);
  return new;
end;
$$;

-- Backfill: seed any existing user who has zero accounts right now.
do $$
declare r record;
begin
  for r in select id from auth.users where id not in (select distinct user_id from accounts) loop
    perform seed_user_data(r.id);
  end loop;
end $$;

-- Fix: category/account name matching was case-sensitive, so a CSV value
-- like "Odd jobs" failed to match the seeded "Odd Jobs". All ten read
-- functions text-match on exact equality already worked for actual user
-- data; the lookups that needed loosening live in the edge functions
-- (writeRegistry.ts, csv-import/index.ts), not in SQL — no further SQL
-- change needed here, those two files are updated alongside this migration.
