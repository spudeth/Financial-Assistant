// Write function registry. Claude never calls these directly — it only
// fills out the matching intent object (the chat function returns that
// object, unexecuted, to the client). These handlers are invoked ONLY by
// the confirm function, after the user accepts. Each one resolves names to
// ids, writes one row, and appends an audit_log entry (ported from v1's
// appendLog pattern).
//
// Accounts/categories are derivative — nothing is pre-seeded. Categories
// auto-create passively here (findOrCreateCategory) since a sloppy/rough
// category is fine, the user can rename/edit later. Accounts do NOT
// auto-create from chat — lookupAccountId stays find-or-throw, so an
// unrecognized account name surfaces as an error rather than inventing a
// new account from a hallucinated or misheard name. CSV import is the only
// place accounts get created on the fly (see ledger.ts / csv-import).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { exact, findOrCreateCategory } from './ledger.ts';
import { categoryNameParts } from './vocab.ts';

function parseAmount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`Amount must be a positive number, got: ${JSON.stringify(value)}`);
  }
  return Math.round(n * 100) / 100;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${field}" is required`);
  return value.trim();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function lookupAccountId(supabase: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await supabase.from('accounts').select('id').ilike('name', exact(name)).single();
  if (error || !data) throw new Error(`Account "${name}" does not exist`);
  return data.id;
}

// Budgets must target a category that already exists — find-or-throw, never create.
async function lookupCategoryId(supabase: SupabaseClient, categoryPath: string, kind: 'income' | 'expense'): Promise<string> {
  const { parent, child } = categoryNameParts(categoryPath);
  const { data: parentRow, error: parentErr } = await supabase
    .from('categories').select('id').ilike('name', exact(parent)).eq('kind', kind).is('parent_id', null).single();
  if (parentErr || !parentRow) throw new Error(`Category "${parent}" does not exist for ${kind}`);
  if (!child) return parentRow.id;

  const { data: childRow, error: childErr } = await supabase
    .from('categories').select('id').ilike('name', exact(child)).eq('kind', kind).eq('parent_id', parentRow.id).single();
  if (childErr || !childRow) throw new Error(`Subcategory "${categoryPath}" does not exist`);
  return childRow.id;
}

async function getAccountBalance(supabase: SupabaseClient, accountId: string): Promise<number> {
  const { data: acct, error } = await supabase.from('accounts').select('starting_balance').eq('id', accountId).single();
  if (error || !acct) throw new Error('Could not load account');
  const { data: postings } = await supabase.from('postings').select('delta').eq('account_id', accountId);
  const total = (postings ?? []).reduce((sum: number, p: { delta: number }) => sum + Number(p.delta), 0);
  return Number(acct.starting_balance) + total;
}

async function appendAudit(
  supabase: SupabaseClient,
  userId: string,
  action: string,
  tableName: string,
  recordId: string | null,
  before: unknown,
  after: unknown
) {
  await supabase.from('audit_log').insert({
    user_id: userId,
    action,
    table_name: tableName,
    record_id: recordId,
    before_data: before,
    after_data: after,
  });
}

type WriteHandler = (supabase: SupabaseClient, userId: string, input: Record<string, unknown>) => Promise<unknown>;

async function addExpenseOrIncome(
  supabase: SupabaseClient,
  userId: string,
  input: Record<string, unknown>,
  type: 'expense' | 'income'
) {
  const category = requireString(input.category, 'category');
  const account = requireString(input.account, 'account');

  const amount = parseAmount(input.amount);
  const account_id = await lookupAccountId(supabase, account);
  const category_id = await findOrCreateCategory(supabase, userId, category, type);
  const occurred_on = (input.date as string) || todayIso();

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      occurred_on,
      type,
      amount,
      account_id,
      category_id,
      payee: input.payee ?? null,
      note: input.note ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await appendAudit(supabase, userId, `add_${type}`, 'transactions', data.id, null, data);
  return data;
}

export const writeRegistry: Record<string, WriteHandler> = {
  add_expense: (supabase, userId, input) => addExpenseOrIncome(supabase, userId, input, 'expense'),
  add_income: (supabase, userId, input) => addExpenseOrIncome(supabase, userId, input, 'income'),

  add_transfer: async (supabase, userId, input) => {
    const fromAccount = requireString(input.from_account, 'from_account');
    const toAccount = requireString(input.to_account, 'to_account');
    if (fromAccount === toAccount) throw new Error('from_account and to_account must be different');

    const amount = parseAmount(input.amount);
    const account_id = await lookupAccountId(supabase, fromAccount);
    const counterparty_account_id = await lookupAccountId(supabase, toAccount);
    const occurred_on = (input.date as string) || todayIso();

    const { data, error } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        occurred_on,
        type: 'transfer',
        amount,
        account_id,
        counterparty_account_id,
        note: input.note ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'add_transfer', 'transactions', data.id, null, data);
    return data;
  },

  add_recurring: async (supabase, userId, input) => {
    const type = requireString(input.type, 'type') as 'income' | 'expense';
    if (type !== 'income' && type !== 'expense') throw new Error('type must be "income" or "expense"');
    const category = requireString(input.category, 'category');
    const account = requireString(input.account, 'account');
    const frequency = requireString(input.frequency, 'frequency');
    if (!['weekly', 'biweekly', 'monthly', 'yearly'].includes(frequency)) {
      throw new Error(`"${frequency}" is not a recognized frequency`);
    }

    const amount = parseAmount(input.amount);
    const account_id = await lookupAccountId(supabase, account);
    const category_id = await findOrCreateCategory(supabase, userId, category, type);
    const next_on = requireString(input.start, 'start');

    const { data, error } = await supabase
      .from('recurrences')
      .insert({
        user_id: userId,
        type,
        amount,
        account_id,
        category_id,
        payee: input.payee ?? null,
        frequency,
        next_on,
        end_on: input.end ?? null,
        mode: 'repeat',
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'add_recurring', 'recurrences', data.id, null, data);
    return data;
  },

  edit_transaction: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const patch = (input.patch as Record<string, unknown>) ?? {};

    const { data: existing, error: fetchErr } = await supabase.from('transactions').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Transaction "${id}" not found`);

    const update: Record<string, unknown> = {};
    if (patch.amount !== undefined) update.amount = parseAmount(patch.amount);
    if (patch.date !== undefined) update.occurred_on = patch.date;
    if (patch.payee !== undefined) update.payee = patch.payee;
    if (patch.note !== undefined) update.note = patch.note;
    if (patch.account !== undefined) {
      update.account_id = await lookupAccountId(supabase, requireString(patch.account, 'account'));
    }
    if (patch.category !== undefined) {
      const category = requireString(patch.category, 'category');
      update.category_id = await findOrCreateCategory(supabase, userId, category, existing.type === 'income' ? 'income' : 'expense');
    }

    const { data, error } = await supabase.from('transactions').update(update).eq('id', id).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'edit_transaction', 'transactions', id, existing, data);
    return data;
  },

  delete_transaction: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const { data: existing, error: fetchErr } = await supabase.from('transactions').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Transaction "${id}" not found`);

    const { error } = await supabase.from('transactions').delete().eq('id', id);
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'delete_transaction', 'transactions', id, existing, null);
    return { deleted: true, id };
  },

  rename_category: async (supabase, userId, input) => {
    const oldName = requireString(input.old_name, 'old_name');
    const newName = requireString(input.new_name, 'new_name');
    const kind = requireString(input.kind, 'kind') as 'income' | 'expense';
    if (kind !== 'income' && kind !== 'expense') throw new Error('kind must be "income" or "expense"');

    const { data: existing, error: fetchErr } = await supabase
      .from('categories').select('*').ilike('name', exact(oldName)).eq('kind', kind).single();
    if (fetchErr || !existing) throw new Error(`Category "${oldName}" does not exist for ${kind}`);

    const { data, error } = await supabase.from('categories').update({ name: newName }).eq('id', existing.id).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'rename_category', 'categories', existing.id, existing, data);
    return data;
  },

  add_budget: async (supabase, userId, input) => {
    const category = requireString(input.category, 'category');
    const period = requireString(input.period, 'period');
    if (!['weekly', 'monthly', 'annually'].includes(period)) throw new Error(`"${period}" is not a recognized period`);
    const amount = parseAmount(input.amount);

    // Budgets only target a category that's already real — find-or-throw.
    // Try expense first (the common case), then income.
    let category_id: string;
    try {
      category_id = await lookupCategoryId(supabase, category, 'expense');
    } catch {
      category_id = await lookupCategoryId(supabase, category, 'income');
    }

    const { data, error } = await supabase
      .from('budgets').insert({ user_id: userId, category_id, period, amount }).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'add_budget', 'budgets', data.id, null, data);
    return data;
  },

  update_budget: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const patch = (input.patch as Record<string, unknown>) ?? {};

    const { data: existing, error: fetchErr } = await supabase.from('budgets').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Budget "${id}" not found`);

    const update: Record<string, unknown> = {};
    if (patch.amount !== undefined) update.amount = parseAmount(patch.amount);
    if (patch.period !== undefined) {
      const period = requireString(patch.period, 'period');
      if (!['weekly', 'monthly', 'annually'].includes(period)) throw new Error(`"${period}" is not a recognized period`);
      update.period = period;
    }

    const { data, error } = await supabase.from('budgets').update(update).eq('id', id).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'update_budget', 'budgets', id, existing, data);
    return data;
  },

  delete_budget: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const { data: existing, error: fetchErr } = await supabase.from('budgets').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Budget "${id}" not found`);

    const { error } = await supabase.from('budgets').delete().eq('id', id);
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'delete_budget', 'budgets', id, existing, null);
    return { deleted: true, id };
  },

  adjust_balance: async (supabase, userId, input) => {
    const account = requireString(input.account, 'account');
    const treatAs = requireString(input.treat_as, 'treat_as') as 'adjustment' | 'expense' | 'income';
    if (!['adjustment', 'expense', 'income'].includes(treatAs)) {
      throw new Error('treat_as must be "adjustment", "expense", or "income"');
    }
    const rawTarget = typeof input.target_balance === 'string' ? Number(input.target_balance) : input.target_balance;
    if (typeof rawTarget !== 'number' || !Number.isFinite(rawTarget)) {
      throw new Error(`target_balance must be a number, got: ${JSON.stringify(input.target_balance)}`);
    }
    const targetBalance = Math.round(rawTarget * 100) / 100;

    const account_id = await lookupAccountId(supabase, account);
    const currentBalance = await getAccountBalance(supabase, account_id);
    const delta = Math.round((targetBalance - currentBalance) * 100) / 100;

    if (delta === 0) return { adjusted: false, message: 'Balance already matches — nothing to do.' };

    if (treatAs === 'income' && delta <= 0) {
      throw new Error('Target balance is lower than the current balance — that would be an expense or adjustment, not income.');
    }
    if (treatAs === 'expense' && delta >= 0) {
      throw new Error('Target balance is higher than the current balance — that would be income or an adjustment, not an expense.');
    }

    let category_id: string | null = null;
    if (treatAs !== 'adjustment') {
      const category = requireString(input.category, 'category');
      category_id = await findOrCreateCategory(supabase, userId, category, treatAs);
    }

    const { data, error } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        occurred_on: todayIso(),
        type: treatAs,
        amount: treatAs === 'adjustment' ? delta : Math.abs(delta),
        account_id,
        category_id,
        note: (input.note as string) ?? 'Balance correction',
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'adjust_balance', 'transactions', data.id, null, data);
    return data;
  },
};

export function writeToolDefs() {
  return [
    {
      name: 'add_expense',
      description: 'Log an expense.',
      input_schema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string' },
          account: { type: 'string' },
          payee: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
          note: { type: 'string' },
        },
        required: ['amount', 'category', 'account'],
      },
    },
    {
      name: 'add_income',
      description: 'Log income.',
      input_schema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string' },
          account: { type: 'string' },
          payee: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
          note: { type: 'string' },
        },
        required: ['amount', 'category', 'account'],
      },
    },
    {
      name: 'add_transfer',
      description: 'Move money between two of the user\'s own accounts.',
      input_schema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          from_account: { type: 'string' },
          to_account: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
          note: { type: 'string' },
        },
        required: ['amount', 'from_account', 'to_account'],
      },
    },
    {
      name: 'add_recurring',
      description: 'Set up a recurring income or expense.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['income', 'expense'] },
          amount: { type: 'number' },
          category: { type: 'string' },
          account: { type: 'string' },
          payee: { type: 'string' },
          frequency: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'yearly'] },
          start: { type: 'string', description: 'YYYY-MM-DD' },
          end: { type: 'string', description: 'YYYY-MM-DD, optional' },
        },
        required: ['type', 'amount', 'category', 'account', 'frequency', 'start'],
      },
    },
    {
      name: 'edit_transaction',
      description: 'Edit an existing transaction.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              category: { type: 'string' },
              account: { type: 'string' },
              payee: { type: 'string' },
              date: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
        required: ['id', 'patch'],
      },
    },
    {
      name: 'delete_transaction',
      description: 'Delete an existing transaction.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'rename_category',
      description: 'Rename an existing category.',
      input_schema: {
        type: 'object',
        properties: {
          old_name: { type: 'string' },
          new_name: { type: 'string' },
          kind: { type: 'string', enum: ['income', 'expense'] },
        },
        required: ['old_name', 'new_name', 'kind'],
      },
    },
    {
      name: 'add_budget',
      description: 'Set a budget for an existing category.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          amount: { type: 'number' },
          period: { type: 'string', enum: ['weekly', 'monthly', 'annually'] },
        },
        required: ['category', 'amount', 'period'],
      },
    },
    {
      name: 'update_budget',
      description: 'Change an existing budget\'s amount or period.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              period: { type: 'string', enum: ['weekly', 'monthly', 'annually'] },
            },
          },
        },
        required: ['id', 'patch'],
      },
    },
    {
      name: 'delete_budget',
      description: 'Remove a budget.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'adjust_balance',
      description: 'Correct an account\'s balance to match what the user says it actually is. Computes the needed change and records it as a visible transaction.',
      input_schema: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          target_balance: { type: 'number', description: 'What the balance should actually be' },
          treat_as: {
            type: 'string',
            enum: ['adjustment', 'expense', 'income'],
            description: '"adjustment" if it\'s just a correction with no income/expense meaning; "expense"/"income" if the difference is a real expense or income the user wants reflected in their totals',
          },
          category: { type: 'string', description: 'Required if treat_as is "expense" or "income"' },
          note: { type: 'string' },
        },
        required: ['account', 'target_balance', 'treat_as'],
      },
    },
  ];
}
