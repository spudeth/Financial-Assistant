# CLAUDE.md — Financial Assistant App Context

You are building a React Native (Expo) app called Financial Assistant. This file is your source of truth. Read it fully before writing any code.

---

## What this app does

The user talks to the app like a human. The app reads, logs, and manages their personal finances through conversation. The user has no direct view of the database. They can only see their data by asking the AI or exporting a CSV.

Stack: React Native + Expo · Supabase (PostgreSQL + Edge Functions) · Anthropic API (Claude)

---

## The three flows — everything in this app is one of these

### FLOW 1: READ
User asks for information.

- DB bundles: user message + system prompt + function definitions + category list + account list
- Claude classifies intent as READ, selects which read function(s) to call
- DB executes the function(s), returns pre-aggregated data (never raw rows)
- Claude composes a conversational response matching the user's tone
- Response renders in chat

### FLOW 2: WRITE
User logs or updates data.

- DB bundles: user message + routing prompt
- Claude classifies intent as WRITE
- DB then sends: last 30 days of transactions + write function definitions + category list
- Claude fills out a structured intent object (type, amount, category, account, payee, date)
- DB renders intent object as a confirmation popup — pushes to user's screen
- Claude's job is done here. It does not execute anything.

Intent object shape:
```json
{
  "intent": "add_expense",
  "amount": 6.00,
  "category": "Food/Drinks > Beverages",
  "account": "Chase",
  "payee": "Celci",
  "date": "2026-06-18"
}
```

### FLOW 3: CONFIRM
Popup is on screen. Three outcomes:

- **Accept** → DB executes the write function → done
- **Reject** → nothing happens → popup closes
- **Edit** → spawn a NEW, separate Anthropic API call (micro-agent) with ONLY: the pending intent object + user's edit instruction. No conversation history. It patches the intent and sends back an updated popup. Loop repeats until accepted or rejected.

The popup is the state holder. It never leaves the screen until the user responds. No polling required.

---

## Database schema

### Tables

```sql
accounts (id, name, group_type, is_liability, starting_balance, archived, created_at)
-- group_type: cash | bank | wallet | card | prepaid

categories (id, name, parent_id, kind, archived)
-- kind: expense | income
-- parent_id: null = top-level category

transactions (id, occurred_on, type, amount, account_id, counterparty_account_id, category_id, payee, note, recurrence_id, created_at)
-- type: income | expense | transfer
-- amount: always positive
-- counterparty_account_id: only populated for transfers
-- category_id: null for transfers

recurrences (id, frequency, interval, next_on, end_on, mode)
-- mode: repeat | installment

budgets (id, category_id, period, amount)
-- period: weekly | monthly | annually
```

### The postings view (derived — do not store separately)

```sql
create view postings as
  select id as txn_id, occurred_on, account_id, -amount as delta from transactions where type='expense'
  union all
  select id, occurred_on, account_id, amount from transactions where type='income'
  union all
  select id, occurred_on, account_id, -amount from transactions where type='transfer'
  union all
  select id, occurred_on, counterparty_account_id, amount from transactions where type='transfer';
```

Account balance formula (one formula, every account):
```sql
starting_balance + coalesce(sum(delta), 0) from postings where account_id = ?
```

---

## Read functions (hardcoded in Supabase Edge Functions)

Claude calls these by name. It never computes aggregates itself.

| Function | Params | Returns |
|---|---|---|
| `transaction_search` | account?, category?, type?, payee?, start_date?, end_date?, group_by? (day\|week\|month) | flat matching rows, or bucketed with subtotals if `group_by` is set |
| `period_totals` | start_date, end_date, granularity (day\|week\|month) | income/expense/net per bucket |
| `category_breakdown` | start_date, end_date | per-category amount + % |
| `budget_vs_actual` | month | per-category budget vs spent |
| `accounts_overview` | — | all account balances + assets/liabilities/net worth |
| `account_ledger` | account, start_date, end_date | running balance history |
| `recurring_transactions` | — | active recurring transactions with frequency + next date |

All functions return name-resolved data (no raw IDs). Every time-range param uses `start_date`/`end_date` (YYYY-MM-DD) consistently — no function takes a bare `month` or `year` except `budget_vs_actual`, since budgets are inherently period-scoped rather than arbitrary ranges.

---

## Write functions (hardcoded in Supabase Edge Functions)

These execute only after user confirmation. Never call these directly from Claude's output.

- `add_expense(amount, category, account, payee, date, note?)`
- `add_income(amount, category, account, payee?, date, note?)`
- `add_transfer(amount, from_account, to_account, date, note?)`
- `add_recurring(type, amount, category, account, payee, frequency, start, end?)`
- `edit_transaction(id, patch)`
- `delete_transaction(id)`
- `create_category(name, parent_id, kind)` — requires its own confirmation

---

## Fixed vocabularies — inject into every prompt

Claude must return exact strings from these lists. DB validates on write. If Claude returns a string not in this list, reject and retry.

### Expense categories
Business Expenses · Vices · Vices > Weed · Vices > Squares · Food/Drinks · Food/Drinks > Beverages · Food/Drinks > Lunch · Food/Drinks > Dinner · Food/Drinks > Breakfast · Food/Drinks > Eating out · Food/Drinks > Snacks · Food/Drinks > Shopping · Phone · Travel · Travel > Ventra · Travel > Metra · Gym · Storage · Housing · Apple · Crypto · Lifestyle · Fun · Gift · Laundry · Haircut · Other

### Income categories
Temp Work · Temp Work > Personal Training · Temp Work > Canvassing · Odd Jobs · Crypto · Other Income

### Accounts
Chase · Chime · Cash · Venmo · Cashapp · Octopharma · 7-Eleven · Temp cards · DoorDash Crimson

---

## Intent routing (first step in every request)

Before pulling any data, classify the user's message into one of three buckets:

- **READ** — user wants information
- **WRITE** — user wants to log or change something
- **CONVERSATIONAL** — no data action needed

Each bucket gets a different context payload and a different prompt. This is a separate lightweight API call before the main one.

---

## Rules Claude must follow (enforce in system prompt)

1. Never invent a category or account name. Pick from the list or propose creating a new one.
2. Never write to the database directly. Always produce an intent object.
3. Never dump raw transaction rows when a summary function exists.
4. Match the user's conversational tone. If they're casual, be casual.
5. When categorizing, use the broadest matching existing category. Starbucks and Dunkin' are both Food/Drinks > Beverages. The payee column stores the specific name.
6. When in doubt about category, include the last 30 days of transactions in context and reason from the user's existing patterns.

---

## What is NOT built yet (v1 scope)

- Split transactions (one purchase across multiple categories)
- Multi-currency
- Octopharma credit card payable/outstanding distinction (treat as normal liability account for now)
- Crash recovery for pending confirmations (v2)

---

## CSV export

Every user can export their full transaction history as a CSV. This is the only direct data view outside the chat.

Export column order: `Period, Account, Category, Subcategory, Note, Amount, Type, Description`

- `Period` → `occurred_on` formatted as MM/DD/YYYY
- `Type` → `Exp.` for expense, `Income` for income, `Transfer-Out` / `Transfer-In` for transfers (transfers export as two rows, matching the source format)
- Strip emojis from category names on export
- Transfers: export both sides — one row as Transfer-Out from source account, one row as Transfer-In to destination account

---

## CSV import

**Do not use Claude to parse CSV rows. This is a deterministic function, not a reasoning task.**

The import function is a hardcoded Supabase Edge Function. It runs programmatically and only surfaces exceptions to the user — not every row.

### Source format (from Money Manager export)
Columns: `Period, Accounts, Category, Subcategory, Note, USD, Income/Expense, Description, Amount, Currency, Accounts`

### Mapping rules

| CSV field | Maps to |
|---|---|
| `Period` | `occurred_on` (parse MM/DD/YYYY → date) |
| `Accounts` | `account_id` (trim whitespace, lookup by name) |
| `Category` | `category_id` (strip emoji, trim, lookup parent) |
| `Subcategory` | `category_id` (lookup child, fall back to parent if not found) |
| `Note` | `payee` (treat as payee name) |
| `Amount` | `amount` (always positive) |
| `Income/Expense` | `type` mapping below |

### Type mapping
- `Exp.` → `expense`
- `Income` → `income`
- `Income Balance` → `income` (treat same as income)
- `Transfer-Out` → `transfer` (this row is the canonical one — use Account as from_account, Category column as to_account)
- `Transfer-In` → **skip** (the Transfer-Out row already captures the full transfer)

### Pre-processing steps (run before row-by-row insert)
1. Trim all string fields — account names have trailing spaces in source data
2. Strip emojis from category names (🍜 Food/Drinks → Food/Drinks)
3. Normalize account names to match accounts table exactly
4. For Transfer-Out rows: the `Category` column contains the destination account name — parse it as `counterparty_account_id`

### Exception handling — flag these, do not fail silently
- Category or subcategory not found in categories table → flag row, show user
- Account name not found in accounts table → flag row, show user
- `Modified Bal.` category → flag as reconciliation entry, skip insert, log separately
- Transfer-Out with no matching account in Category column → flag row
- Any row where amount is null or zero → flag row

### User experience
- Upload CSV → import runs → show result: "X rows imported, Y flagged for review"
- User only sees the flagged rows, not every row
- Flagged rows show the raw CSV line + reason it was flagged + a manual input to resolve it
- Once resolved, user confirms and those rows insert normally

### Categories present in source CSV not previously in schema (now added above)
Crypto · Lifestyle · Fun · Gift · Laundry · Haircut · Odd Jobs · Vices > Squares · Food/Drinks > Dinner · Food/Drinks > Breakfast · Food/Drinks > Eating out · Food/Drinks > Snacks · Food/Drinks > Shopping · Travel > Ventra · Travel > Metra · Temp Work > Canvassing

### Modified Bal. entries
These are balance reconciliation adjustments from the source app — the user manually corrected a discrepancy. They do not map to a real transaction. Skip on import. Log the skipped entries so the user knows their starting balances may need manual adjustment after import.

---

## File structure notes

- Edge functions live in `/supabase/functions/`
- `.env` is local only — never committed
- Three separate deploy targets: `git commit` (your backup), `supabase functions deploy` (edge functions), `expo publish` or `eas build` (app)
- Two Claude Code instances are working on this repo simultaneously: one on API/DB wiring, one on UI. This file is shared context for both.
