-- Surface the recurrence id in the read function so the assistant can target
-- edit_recurring / delete_recurring after looking a bill up. (Same shape as
-- before, plus 'id'.)

create or replace function recurring_transactions()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'type', r.type, 'amount', r.amount, 'account', a.name, 'category', c.name,
    'payee', r.payee, 'frequency', r.frequency, 'interval', r.interval,
    'next_on', r.next_on, 'end_on', r.end_on, 'mode', r.mode
  ) order by r.next_on), '[]'::jsonb)
  from recurrences r
  join accounts a on a.id = r.account_id
  join categories c on c.id = r.category_id
  where r.user_id = auth.uid() and r.active = true;
$$;
