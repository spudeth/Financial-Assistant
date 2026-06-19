-- Consolidate the read-function catalog.
-- Replaces 10 overlapping/inconsistent read functions with 7 that each own
-- one Money-Manager-equivalent informational need, all using the same
-- start_date/end_date shape where a time range applies. See
-- "Finalize the read-function catalog" plan for the full reasoning.

-- ════════════════════════════════════════════════════════════════
-- Drop functions being replaced or reshaped
-- ════════════════════════════════════════════════════════════════

drop function if exists daily_transactions(date);
drop function if exists calendar_totals(date);
drop function if exists monthly_summary(int);
drop function if exists spend_trend(date, date);
drop function if exists account_balances();
drop function if exists net_worth();
drop function if exists account_ledger(text, date);

-- ════════════════════════════════════════════════════════════════
-- transaction_search — unchanged filters, plus an optional group_by
-- ('day' | 'week' | 'month') that buckets the same matching rows with
-- per-bucket income/expense subtotals instead of returning a flat list.
-- This absorbs daily_transactions (which was just group_by: 'day' with
-- no other filters).
-- ════════════════════════════════════════════════════════════════

create or replace function transaction_search(p_filters jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_group_by text := p_filters->>'group_by';
  v_result jsonb;
begin
  if v_group_by is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'occurred_on', x.occurred_on, 'type', x.type, 'amount', x.amount,
      'account', x.account, 'category', x.category, 'payee', x.payee, 'note', x.note
    )), '[]'::jsonb) into v_result
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
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'bucket', g.bucket,
      'income', g.income,
      'expense', g.expense,
      'transactions', g.transactions
    ) order by g.bucket), '[]'::jsonb) into v_result
    from (
      select
        case v_group_by
          when 'day' then to_char(t.occurred_on, 'YYYY-MM-DD')
          when 'week' then to_char(date_trunc('week', t.occurred_on), 'YYYY-MM-DD')
          else to_char(date_trunc('month', t.occurred_on), 'YYYY-MM')
        end as bucket,
        coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0) as income,
        coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as expense,
        jsonb_agg(jsonb_build_object(
          'id', t.id, 'occurred_on', t.occurred_on, 'type', t.type, 'amount', t.amount,
          'account', a.name, 'category', c.name, 'payee', t.payee, 'note', t.note
        ) order by t.occurred_on, t.id) as transactions
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
      group by bucket
    ) g;
  end if;
  return v_result;
end;
$$;

-- ════════════════════════════════════════════════════════════════
-- period_totals — income/expense/net per bucket over a date range, at
-- whichever granularity is asked for. Absorbs calendar_totals (day),
-- monthly_summary (month/week), and spend_trend (month, expense-only —
-- callers just read the 'expense' field per bucket for a trend).
-- ════════════════════════════════════════════════════════════════

create or replace function period_totals(p_start date, p_end date, p_granularity text default 'month')
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'period', case p_granularity
      when 'day' then to_char(bucket, 'YYYY-MM-DD')
      when 'week' then to_char(bucket, 'YYYY-MM-DD')
      else to_char(bucket, 'YYYY-MM')
    end,
    'income', income, 'expense', expense, 'net', income - expense
  ) order by bucket), '[]'::jsonb)
  from (
    select
      case p_granularity
        when 'day' then t.occurred_on
        when 'week' then date_trunc('week', t.occurred_on)::date
        else date_trunc('month', t.occurred_on)::date
      end as bucket,
      coalesce(sum(case when t.type = 'income' then t.amount else 0 end), 0) as income,
      coalesce(sum(case when t.type = 'expense' then t.amount else 0 end), 0) as expense
    from transactions t join accounts a on a.id = t.account_id
    where a.user_id = auth.uid() and t.occurred_on between p_start and p_end
    group by 1
  ) x;
$$;

-- ════════════════════════════════════════════════════════════════
-- accounts_overview — per-account balances plus the assets/liabilities/
-- net_worth rollup in one call. Absorbs account_balances and net_worth.
-- ════════════════════════════════════════════════════════════════

create or replace function accounts_overview()
returns jsonb language sql stable as $$
  with bal as (
    select a.name, a.group_type, coalesce(a.is_liability, false) as is_liability,
      a.starting_balance + coalesce(p.total, 0) as balance
    from accounts a
    left join (select account_id, sum(delta) as total from postings group by account_id) p on p.account_id = a.id
    where a.user_id = auth.uid() and a.archived = false
  )
  select jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
      'account', name, 'group_type', group_type, 'is_liability', is_liability, 'balance', balance
    )) from bal), '[]'::jsonb),
    'assets', coalesce((select sum(balance) from bal where not is_liability), 0),
    'liabilities', coalesce((select sum(balance) from bal where is_liability), 0),
    'net_worth', coalesce((select sum(case when is_liability then -balance else balance end) from bal), 0)
  );
$$;

-- ════════════════════════════════════════════════════════════════
-- account_ledger — same running-balance history as before, but takes a
-- date range instead of being locked to one calendar month.
-- ════════════════════════════════════════════════════════════════

create or replace function account_ledger(p_account_name text, p_start date, p_end date)
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
  where occurred_on between p_start and p_end;
$$;

-- ════════════════════════════════════════════════════════════════
-- recurring_transactions — new. Fills the gap: there was no read
-- function for the recurrences table even though add_recurring exists
-- on the write side and Money Manager surfaces this explicitly.
-- ════════════════════════════════════════════════════════════════

create or replace function recurring_transactions()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'type', r.type, 'amount', r.amount, 'account', a.name, 'category', c.name,
    'payee', r.payee, 'frequency', r.frequency, 'interval', r.interval,
    'next_on', r.next_on, 'end_on', r.end_on, 'mode', r.mode
  ) order by r.next_on), '[]'::jsonb)
  from recurrences r
  join accounts a on a.id = r.account_id
  join categories c on c.id = r.category_id
  where r.user_id = auth.uid() and r.active = true;
$$;

-- category_breakdown and budget_vs_actual are unchanged — no overlap,
-- already consistent params.
