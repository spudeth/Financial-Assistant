-- category_breakdown was hardcoded to expense transactions only, with no
-- way to ask for an income or transfer breakdown — it's just a summation
-- by category, so there's no reason it should be type-locked. Add an
-- optional p_type filter (defaults to all types) so one function covers
-- "spending by category", "income by category", or "everything", and the
-- % column stays meaningful by computing each row's share within its own
-- type's total rather than mixing income and expense into one pool.

create or replace function category_breakdown(p_start date, p_end date, p_type text default null)
returns jsonb language sql stable as $$
  with base as (
    select coalesce(c.name, 'Uncategorized') as category, t.type, sum(t.amount) as amt
    from transactions t join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where a.user_id = auth.uid()
      and t.occurred_on between p_start and p_end
      and (p_type is null or t.type = p_type)
    group by 1, 2
  ), totals as (
    select type, sum(amt) as t from base group by type
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'category', b.category,
    'type', b.type,
    'amount', b.amt,
    'pct', case when tt.t = 0 then 0 else round(b.amt / tt.t * 100, 1) end
  ) order by b.type, b.amt desc), '[]'::jsonb)
  from base b
  join totals tt on tt.type = b.type;
$$;
