-- Financial Assistant — core engine schema
-- Tables, RLS, the postings view, read functions, and new-user seeding.
-- Base shape comes from Final Phase Context.md. Deviation: every table gets
-- user_id (the spec's tables omit it, but this app already has full
-- multi-user Supabase Auth wired up, so user_id + RLS is required for
-- correctness even though today there's only one real user).

-- ════════════════════════════════════════════════════════════════
-- Core tables
-- ════════════════════════════════════════════════════════════════

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  group_type text check (group_type in ('cash','bank','wallet','card','prepaid')),
  is_liability boolean,
  starting_balance numeric(12,2) not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
-- group_type/is_liability are nullable: an account starts "unclassified" until
-- either a known-pattern match resolves it automatically, or the user answers
-- a classification prompt in chat (see account_type_hints below).

create table categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_id uuid references categories(id) on delete cascade,
  kind text not null check (kind in ('expense','income')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name, parent_id, kind)
);

-- Final Phase Context.md's recurrences table only listed
-- (frequency, interval, next_on, end_on, mode) — that leaves nowhere to
-- store what the recurring transaction actually is. Adding the same
-- fields a one-off transaction needs (type/amount/account/category/payee)
-- so add_recurring has something real to write and applying a due rule
-- can create an actual transaction from it.
create table recurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('income','expense')),
  amount numeric(12,2) not null check (amount > 0),
  account_id uuid not null references accounts(id) on delete restrict,
  category_id uuid not null references categories(id) on delete restrict,
  payee text,
  note text,
  frequency text not null check (frequency in ('weekly','biweekly','monthly','yearly')),
  interval int not null default 1,
  next_on date not null,
  end_on date,
  mode text not null check (mode in ('repeat','installment')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_on date not null,
  type text not null check (type in ('income','expense','transfer')),
  amount numeric(12,2) not null check (amount > 0),
  account_id uuid not null references accounts(id) on delete restrict,
  counterparty_account_id uuid references accounts(id) on delete restrict,
  category_id uuid references categories(id) on delete set null,
  payee text,
  note text,
  recurrence_id uuid references recurrences(id) on delete set null,
  created_at timestamptz not null default now(),
  check (type <> 'transfer' or counterparty_account_id is not null),
  check (type = 'transfer' or category_id is not null)
);

create table budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  period text not null check (period in ('weekly','monthly','annually')),
  amount numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (user_id, category_id, period)
);

-- ════════════════════════════════════════════════════════════════
-- Chat history
-- ════════════════════════════════════════════════════════════════

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════
-- Audit trail (ported pattern from v1's appendLog)
-- ════════════════════════════════════════════════════════════════

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  table_name text not null,
  record_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════
-- CSV import exception tracking
-- ════════════════════════════════════════════════════════════════

create table csv_import_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_row jsonb not null,
  reason text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════
-- Account type hints — a growable, cloud-stored heuristic list for
-- auto-classifying accounts by name (e.g. "chase" -> bank). Read-only
-- to clients; grows over time as we see new account names. Anything
-- that doesn't match a hint stays unclassified and gets surfaced to
-- the user as a classification question instead of being guessed.
-- ════════════════════════════════════════════════════════════════

create table account_type_hints (
  id uuid primary key default gen_random_uuid(),
  pattern text not null unique, -- lowercase substring matched against account name
  group_type text not null check (group_type in ('cash','bank','wallet','card','prepaid')),
  is_liability boolean not null default false,
  created_at timestamptz not null default now()
);

insert into account_type_hints (pattern, group_type, is_liability) values
  ('chase', 'bank', false),
  ('chime', 'bank', false),
  ('wells fargo', 'bank', false),
  ('bank of america', 'bank', false),
  ('huntington', 'bank', false),
  ('citibank', 'bank', false),
  ('capital one', 'bank', false),
  ('ally', 'bank', false),
  ('pnc', 'bank', false),
  ('us bank', 'bank', false),
  ('td bank', 'bank', false),
  ('regions', 'bank', false),
  ('sofi', 'bank', false),
  ('discover bank', 'bank', false),
  ('venmo', 'wallet', false),
  ('cashapp', 'wallet', false),
  ('cash app', 'wallet', false),
  ('paypal', 'wallet', false),
  ('zelle', 'wallet', false),
  ('apple cash', 'wallet', false),
  ('visa', 'card', true),
  ('mastercard', 'card', true),
  ('amex', 'card', true),
  ('american express', 'card', true),
  ('discover card', 'card', true),
  ('credit', 'card', true),
  ('cash', 'cash', false),
  ('gift card', 'prepaid', false),
  ('giftcard', 'prepaid', false),
  ('prepaid', 'prepaid', false);

-- ════════════════════════════════════════════════════════════════
-- Postings view — derived, per Final Phase Context.md (verbatim)
-- ════════════════════════════════════════════════════════════════

create view postings with (security_invoker = true) as
  select id as txn_id, occurred_on, account_id, -amount as delta from transactions where type = 'expense'
  union all
  select id, occurred_on, account_id, amount from transactions where type = 'income'
  union all
  select id, occurred_on, account_id, -amount from transactions where type = 'transfer'
  union all
  select id, occurred_on, counterparty_account_id, amount from transactions where type = 'transfer';

-- ════════════════════════════════════════════════════════════════
-- Row Level Security — every user-owned table is scoped to auth.uid()
-- ════════════════════════════════════════════════════════════════

alter table accounts enable row level security;
alter table categories enable row level security;
alter table recurrences enable row level security;
alter table transactions enable row level security;
alter table budgets enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table audit_log enable row level security;
alter table csv_import_flags enable row level security;
alter table account_type_hints enable row level security;

create policy "own rows" on accounts for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on categories for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on recurrences for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on transactions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on budgets for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on messages for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on audit_log for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on csv_import_flags for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "read only" on account_type_hints for select using (true);

-- ════════════════════════════════════════════════════════════════
-- New-user seeding — fixed category vocab + fixed account list from
-- Final Phase Context.md. Account group_type/is_liability resolve via
-- account_type_hints where possible; anything unmatched is left null
-- (pending classification, surfaced later by the chat/settings UI).
-- ════════════════════════════════════════════════════════════════

-- Pulled out of the trigger so it can also be called as a one-off backfill
-- for any user whose row predates this migration (the trigger only fires
-- on INSERT into auth.users, so existing users never get seeded otherwise).
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
  -- expense top-level categories
  foreach v_name in array v_expense_top loop
    insert into categories (user_id, name, kind) values (v_user_id, v_name, 'expense');
  end loop;
  -- income top-level categories
  foreach v_name in array v_income_top loop
    insert into categories (user_id, name, kind) values (v_user_id, v_name, 'income');
  end loop;

  -- expense subcategories
  for v_group in select * from jsonb_array_elements(v_expense_children) loop
    select id into v_parent_id from categories
      where user_id = v_user_id and kind = 'expense' and name = v_group->>'parent';
    for v_child in select jsonb_array_elements_text(v_group->'children') loop
      insert into categories (user_id, name, parent_id, kind) values (v_user_id, v_child, v_parent_id, 'expense');
    end loop;
  end loop;

  -- income subcategories
  for v_group in select * from jsonb_array_elements(v_income_children) loop
    select id into v_parent_id from categories
      where user_id = v_user_id and kind = 'income' and name = v_group->>'parent';
    for v_child in select jsonb_array_elements_text(v_group->'children') loop
      insert into categories (user_id, name, parent_id, kind) values (v_user_id, v_child, v_parent_id, 'income');
    end loop;
  end loop;

  -- accounts: explicit known type (Octopharma is called out as a credit
  -- card in the spec) takes priority over hint matching; anything else
  -- tries a hint match, else stays unclassified.
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ════════════════════════════════════════════════════════════════
-- Read functions (Postgres functions called via supabase.rpc()).
-- Each returns jsonb; security invoker (default) means auth.uid()
-- resolves to the calling user and RLS still applies underneath.
-- ════════════════════════════════════════════════════════════════

create or replace function daily_transactions(p_month date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select t.occurred_on, t.id, t.type, t.amount,
      a.name as account, c.name as category, t.payee, t.note
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where a.user_id = auth.uid()
      and date_trunc('month', t.occurred_on) = date_trunc('month', p_month)
    order by t.occurred_on, t.id
  ) d;
$$;

create or replace function calendar_totals(p_month date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select t.occurred_on,
      coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0) as income,
      coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as expense,
      coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0)
        - coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as net
    from transactions t
    join accounts a on a.id = t.account_id
    where a.user_id = auth.uid()
      and date_trunc('month', t.occurred_on) = date_trunc('month', p_month)
    group by t.occurred_on
    order by t.occurred_on
  ) x;
$$;

create or replace function monthly_summary(p_year int)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'by_month', (
      select coalesce(jsonb_agg(m), '[]'::jsonb) from (
        select extract(month from t.occurred_on)::int as month,
          coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0) as income,
          coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as expense
        from transactions t join accounts a on a.id = t.account_id
        where a.user_id = auth.uid() and extract(year from t.occurred_on) = p_year
        group by 1 order by 1
      ) m
    ),
    'by_week', (
      select coalesce(jsonb_agg(w), '[]'::jsonb) from (
        select extract(week from t.occurred_on)::int as week,
          coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0) as income,
          coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as expense
        from transactions t join accounts a on a.id = t.account_id
        where a.user_id = auth.uid() and extract(year from t.occurred_on) = p_year
        group by 1 order by 1
      ) w
    )
  );
$$;

create or replace function category_breakdown(p_start date, p_end date)
returns jsonb language sql stable as $$
  with base as (
    select coalesce(c.name, 'Uncategorized') as category, sum(t.amount) as amt
    from transactions t join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where a.user_id = auth.uid() and t.type = 'expense' and t.occurred_on between p_start and p_end
    group by 1
  ), total as (select coalesce(sum(amt), 0) as t from base)
  select coalesce(jsonb_agg(jsonb_build_object(
    'category', category,
    'amount', amt,
    'pct', case when (select t from total) = 0 then 0 else round(amt / (select t from total) * 100, 1) end
  )), '[]'::jsonb)
  from base;
$$;

create or replace function budget_vs_actual(p_month date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'category', c.name, 'budget', b.amount, 'spent', coalesce(s.spent, 0)
  )), '[]'::jsonb)
  from budgets b
  join categories c on c.id = b.category_id
  left join (
    select t.category_id, sum(t.amount) as spent
    from transactions t join accounts a on a.id = t.account_id
    where a.user_id = auth.uid() and t.type = 'expense'
      and date_trunc('month', t.occurred_on) = date_trunc('month', p_month)
    group by t.category_id
  ) s on s.category_id = b.category_id
  where b.user_id = auth.uid() and b.period = 'monthly';
$$;

create or replace function spend_trend(p_start date, p_end date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(d, 'YYYY-MM'), 'expense', coalesce(e, 0))), '[]'::jsonb)
  from (
    select date_trunc('month', t.occurred_on) as d, sum(t.amount) as e
    from transactions t join accounts a on a.id = t.account_id
    where a.user_id = auth.uid() and t.type = 'expense' and t.occurred_on between p_start and p_end
    group by 1 order by 1
  ) x;
$$;

create or replace function account_balances()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'account', a.name, 'group_type', a.group_type, 'is_liability', a.is_liability,
    'balance', a.starting_balance + coalesce(p.total, 0)
  )), '[]'::jsonb)
  from accounts a
  left join (select account_id, sum(delta) as total from postings group by account_id) p on p.account_id = a.id
  where a.user_id = auth.uid() and a.archived = false;
$$;

create or replace function account_ledger(p_account_name text, p_month date)
returns jsonb language sql stable as $$
  with acct as (select id, starting_balance from accounts where user_id = auth.uid() and name = p_account_name)
  select coalesce(jsonb_agg(jsonb_build_object(
    'occurred_on', occurred_on, 'delta', delta, 'running_balance', running_balance
  )), '[]'::jsonb)
  from (
    select p.occurred_on, p.delta,
      (select starting_balance from acct) + sum(p.delta) over (order by p.occurred_on, p.txn_id) as running_balance
    from postings p
    where p.account_id = (select id from acct)
    order by p.occurred_on
  ) x
  where date_trunc('month', occurred_on) = date_trunc('month', p_month);
$$;

create or replace function net_worth()
returns jsonb language sql stable as $$
  with bal as (
    select coalesce(a.is_liability, false) as is_liability, a.starting_balance + coalesce(p.total, 0) as balance
    from accounts a
    left join (select account_id, sum(delta) as total from postings group by account_id) p on p.account_id = a.id
    where a.user_id = auth.uid() and a.archived = false
  )
  select jsonb_build_object(
    'assets', coalesce(sum(balance) filter (where not is_liability), 0),
    'liabilities', coalesce(sum(balance) filter (where is_liability), 0),
    'net_worth', coalesce(sum(case when is_liability then -balance else balance end), 0)
  ) from bal;
$$;

create or replace function transaction_search(p_filters jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'occurred_on', x.occurred_on, 'type', x.type, 'amount', x.amount,
    'account', x.account, 'category', x.category, 'payee', x.payee, 'note', x.note
  )), '[]'::jsonb)
  from (
    select t.id, t.occurred_on, t.type, t.amount, a.name as account, c.name as category, t.payee, t.note
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where a.user_id = auth.uid()
      and (p_filters->>'account' is null or a.name = p_filters->>'account')
      and (p_filters->>'category' is null or c.name = p_filters->>'category')
      and (p_filters->>'type' is null or t.type = p_filters->>'type')
      and (p_filters->>'payee' is null or t.payee ilike '%' || (p_filters->>'payee') || '%')
      and (p_filters->>'start_date' is null or t.occurred_on >= (p_filters->>'start_date')::date)
      and (p_filters->>'end_date' is null or t.occurred_on <= (p_filters->>'end_date')::date)
    order by t.occurred_on desc, t.id desc
    limit 200
  ) x;
$$;

-- ════════════════════════════════════════════════════════════════
-- Helper read function used by chat/settings UI: which accounts on
-- this user still need type classification (group_type is null)?
-- ════════════════════════════════════════════════════════════════

create or replace function unclassified_accounts()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name)), '[]'::jsonb)
  from accounts
  where user_id = auth.uid() and group_type is null and archived = false;
$$;
