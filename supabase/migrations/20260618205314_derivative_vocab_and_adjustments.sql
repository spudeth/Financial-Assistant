-- Removes fixed-vocab pre-seeding (accounts/categories are now derivative —
-- created on demand by CSV import or chat writes, never pre-populated) and
-- adds a 4th transaction type, 'adjustment', for visible balance corrections
-- (previously planned as a silent starting_balance tweak; reversed per
-- discussion — corrections must be real, visible ledger entries).

-- ════════════════════════════════════════════════════════════════
-- Drop pre-seeding — nothing left to seed once vocab is derivative
-- ════════════════════════════════════════════════════════════════

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();
drop function if exists seed_user_data(uuid);

-- ════════════════════════════════════════════════════════════════
-- transactions: add 'adjustment' type with a signed amount
-- ════════════════════════════════════════════════════════════════

-- Drop every existing check constraint by introspection rather than by
-- guessing Postgres's auto-generated names (two of the original four were
-- unnamed table-level checks, not column checks, so their real names
-- aren't predictable from the original CREATE TABLE text).
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.transactions'::regclass and contype = 'c'
  loop
    execute format('alter table transactions drop constraint %I', r.conname);
  end loop;
end $$;

alter table transactions add constraint transactions_type_check
  check (type in ('income', 'expense', 'transfer', 'adjustment'));

alter table transactions add constraint transactions_amount_check
  check ((type = 'adjustment' and amount <> 0) or (type <> 'adjustment' and amount > 0));

alter table transactions add constraint transactions_transfer_needs_counterparty
  check (type <> 'transfer' or counterparty_account_id is not null);

-- Previously: "type = 'transfer' or category_id is not null" — adjustment
-- rows don't carry a category either, same as transfers.
alter table transactions add constraint transactions_income_expense_needs_category
  check (type not in ('income', 'expense') or category_id is not null);

-- ════════════════════════════════════════════════════════════════
-- postings view: add the adjustment branch (amount is already signed,
-- so no negation needed, unlike expense/transfer-out)
-- ════════════════════════════════════════════════════════════════

drop view if exists postings;
create view postings with (security_invoker = true) as
  select id as txn_id, occurred_on, account_id, -amount as delta from transactions where type = 'expense'
  union all
  select id, occurred_on, account_id, amount from transactions where type = 'income'
  union all
  select id, occurred_on, account_id, -amount from transactions where type = 'transfer'
  union all
  select id, occurred_on, counterparty_account_id, amount from transactions where type = 'transfer'
  union all
  select id, occurred_on, account_id, amount from transactions where type = 'adjustment';
