-- ════════════════════════════════════════════════════════════════
-- Recurring transaction generation: materialize schedules into actual transaction rows
-- ════════════════════════════════════════════════════════════════
-- When a user sets up a recurring transaction (weekly rent, biweekly paycheck, etc.),
-- a single recurrence row is created with the schedule. This function materializes
-- that schedule — for each occurrence within the next 365 days (or until end_on),
-- it creates an actual transaction row that will be visible in reports, balances, etc.
--
-- Called synchronously from the write handlers (add_transaction, edit_recurring,
-- delete_recurring) so the transaction list stays in sync with the schedule.

-- ── Unique index: (recurrence_id, occurred_on) to prevent duplicates ──
-- The generator can be called multiple times safely; the index + on conflict do nothing
-- absorbs retries.
create unique index if not exists transactions_recurrence_occurred_on_idx
  on transactions (recurrence_id, occurred_on) where recurrence_id is not null;

-- ── generate_recurring_transactions(p_recurrence_id) ──
-- Materializes the next 365 days (or until end_on) of a recurrence as transaction rows.
-- Called by the write handlers (add_transaction, edit_recurring, delete_recurring).
create or replace function generate_recurring_transactions(p_recurrence_id uuid)
returns void language plpgsql as $$
declare
  v_recurrence record;
  v_occurred_on date;
  v_next_date date;
  v_days_per_interval int;
begin
  -- Load the recurrence. If it doesn't exist, silently return (may have been deleted).
  select * into v_recurrence from recurrences where id = p_recurrence_id and user_id = auth.uid();
  if not found then return; end if;

  -- Clear all future occurrences (occurred_on > today). This handles both edit
  -- (regenerate with new terms) and cancel (delete all future) cases upfront.
  delete from transactions
    where recurrence_id = p_recurrence_id and occurred_on > current_date;

  -- If the recurrence is cancelled, stop here.
  if not v_recurrence.active then return; end if;

  -- Calculate the number of days per interval based on frequency.
  v_days_per_interval := case v_recurrence.frequency
    when 'weekly' then 7 * v_recurrence.interval
    when 'biweekly' then 14 * v_recurrence.interval
    when 'monthly' then null  -- handled via date + interval
    when 'yearly' then null   -- handled via date + interval
  end;

  -- Step through each occurrence starting from next_on.
  v_occurred_on := v_recurrence.next_on;

  while v_occurred_on <= (current_date + interval '365 days')
    and (v_recurrence.end_on is null or v_occurred_on <= v_recurrence.end_on)
  loop
    -- Skip retroactive dates (shouldn't happen, but safe).
    if v_occurred_on >= current_date then
      insert into transactions (
        user_id, occurred_on, from_account_id, to_account_id, amount,
        category_id, note, recurrence_id
      )
      values (
        v_recurrence.user_id, v_occurred_on, v_recurrence.from_account_id,
        v_recurrence.to_account_id, v_recurrence.amount, v_recurrence.category_id,
        v_recurrence.note, p_recurrence_id
      )
      on conflict (recurrence_id, occurred_on) do nothing;
    end if;

    -- Step to the next occurrence.
    case v_recurrence.frequency
      when 'weekly' then
        v_occurred_on := v_occurred_on + (v_days_per_interval || ' days')::interval;
      when 'biweekly' then
        v_occurred_on := v_occurred_on + (v_days_per_interval || ' days')::interval;
      when 'monthly' then
        v_occurred_on := (v_occurred_on + (v_recurrence.interval || ' months')::interval)::date;
      when 'yearly' then
        v_occurred_on := (v_occurred_on + (v_recurrence.interval || ' years')::interval)::date;
    end case;
  end loop;
end;
$$;
