// Write function registry. Claude never calls these directly — it only fills
// out the matching intent object (chat returns it, unexecuted, to the client).
// These handlers run ONLY from the confirm function, after the user accepts.
//
// The create surface is a single tool: add_transaction. Everything is pure
// double-entry — money moves FROM one account TO another — and the kind
// (income/expense/transfer) is derived from which side is the user's own
// account (is_external = false), never stored. Accounts and categories
// auto-create (findOrCreateAccount/findOrCreateCategory) — a rough name is
// fine, the confirm card lets the user fix it, and nothing commits until they
// approve. The remaining edit handlers also find-or-create on account/category
// patches rather than throwing on a new name.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { exact, findOrCreateAccount, findOrCreateCategory } from './ledger.ts';
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

// Given the two account ids of a transaction, derive whether it reads as
// income, expense, or transfer (for filing an optional category under the
// right income/expense vocab). Transfers (both personal) carry no category.
async function deriveKind(
  supabase: SupabaseClient,
  fromId: string,
  toId: string,
): Promise<'income' | 'expense' | null> {
  const { data: sides } = await supabase.from('accounts').select('id, is_external').in('id', [fromId, toId]);
  const fromExt = sides?.find((s: { id: string; is_external: boolean }) => s.id === fromId)?.is_external ?? true;
  const toExt = sides?.find((s: { id: string; is_external: boolean }) => s.id === toId)?.is_external ?? true;
  return fromExt && !toExt ? 'income' : !fromExt && toExt ? 'expense' : null;
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

export const writeRegistry: Record<string, WriteHandler> = {
  // The one canonical create tool. from_account -> to_account, amount, plus
  // optional category/date/note and optional recurring schedule. from_external
  // / to_external are optional booleans the confirm card sends when the user
  // corrects the bot's personal-vs-external read of an account.
  add_transaction: async (supabase, userId, input) => {
    const fromAccount = requireString(input.from_account, 'from_account');
    const toAccount = requireString(input.to_account, 'to_account');
    if (fromAccount.toLowerCase() === toAccount.toLowerCase()) {
      throw new Error('from_account and to_account must be different');
    }
    const amount = parseAmount(input.amount);
    const from_account_id = await findOrCreateAccount(supabase, userId, fromAccount);
    const to_account_id = await findOrCreateAccount(supabase, userId, toAccount);

    // Apply the user's personal/external corrections from the card (if any),
    // so the derived kind and future reports reflect them.
    if (typeof input.from_external === 'boolean') {
      await supabase.from('accounts').update({ is_external: input.from_external }).eq('id', from_account_id);
    }
    if (typeof input.to_external === 'boolean') {
      await supabase.from('accounts').update({ is_external: input.to_external }).eq('id', to_account_id);
    }

    // Safety net: a transaction with NO personal side is invisible in every
    // report (neither income, expense, nor a balance change). If neither side is
    // personal, treat the source as the user's account — the common "spent from
    // my account" case. The confirm card's Personal/External toggle lets the
    // user correct it.
    {
      const { data: chk } = await supabase.from('accounts').select('id, is_external').in('id', [from_account_id, to_account_id]);
      const fE = chk?.find((a: { id: string; is_external: boolean }) => a.id === from_account_id)?.is_external ?? true;
      const tE = chk?.find((a: { id: string; is_external: boolean }) => a.id === to_account_id)?.is_external ?? true;
      if (fE && tE) await supabase.from('accounts').update({ is_external: false }).eq('id', from_account_id);
    }

    const kind = await deriveKind(supabase, from_account_id, to_account_id);
    let category_id: string | null = null;
    if (kind && input.category && String(input.category).trim()) {
      category_id = await findOrCreateCategory(supabase, userId, String(input.category), kind);
    }

    // recurring => a repeating schedule (future rows generated when due);
    // otherwise a single transaction now.
    if (input.recurring) {
      const frequency = requireString(input.frequency, 'frequency');
      if (!['weekly', 'biweekly', 'monthly', 'yearly'].includes(frequency)) {
        throw new Error(`"${frequency}" is not a recognized frequency`);
      }
      const next_on = requireString(input.start, 'start');
      const { data, error } = await supabase
        .from('recurrences')
        .insert({
          user_id: userId,
          from_account_id,
          to_account_id,
          amount,
          category_id,
          note: input.note ?? null,
          frequency,
          next_on,
          end_on: input.end ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      await appendAudit(supabase, userId, 'add_recurring', 'recurrences', data.id, null, data);
      // Materialize the next 365 days of this recurrence as actual transaction rows.
      await supabase.rpc('generate_recurring_transactions', { p_recurrence_id: data.id });
      return data;
    }

    const occurred_on = (input.date as string) || todayIso();
    const { data, error } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        occurred_on,
        from_account_id,
        to_account_id,
        amount,
        category_id,
        note: input.note ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    await appendAudit(supabase, userId, 'add_transaction', 'transactions', data.id, null, data);
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
    if (patch.note !== undefined) update.note = patch.note;
    if (patch.from_account !== undefined) {
      update.from_account_id = await findOrCreateAccount(supabase, userId, requireString(patch.from_account, 'from_account'));
    }
    if (patch.to_account !== undefined) {
      update.to_account_id = await findOrCreateAccount(supabase, userId, requireString(patch.to_account, 'to_account'));
    }
    if (patch.category !== undefined) {
      const fromId = (update.from_account_id as string) ?? existing.from_account_id;
      const toId = (update.to_account_id as string) ?? existing.to_account_id;
      const kind = await deriveKind(supabase, fromId, toId);
      update.category_id = kind ? await findOrCreateCategory(supabase, userId, requireString(patch.category, 'category'), kind) : null;
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

  edit_recurring: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const patch = (input.patch as Record<string, unknown>) ?? {};

    const { data: existing, error: fetchErr } = await supabase.from('recurrences').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Recurring item "${id}" not found`);

    const update: Record<string, unknown> = {};
    if (patch.amount !== undefined) update.amount = parseAmount(patch.amount);
    if (patch.note !== undefined) update.note = patch.note;
    if (patch.next_on !== undefined) update.next_on = patch.next_on;
    if (patch.end_on !== undefined) update.end_on = patch.end_on;
    if (patch.frequency !== undefined) {
      const frequency = requireString(patch.frequency, 'frequency');
      if (!['weekly', 'biweekly', 'monthly', 'yearly'].includes(frequency)) throw new Error(`"${frequency}" is not a recognized frequency`);
      update.frequency = frequency;
    }
    if (patch.from_account !== undefined) {
      update.from_account_id = await findOrCreateAccount(supabase, userId, requireString(patch.from_account, 'from_account'));
    }
    if (patch.to_account !== undefined) {
      update.to_account_id = await findOrCreateAccount(supabase, userId, requireString(patch.to_account, 'to_account'));
    }
    if (patch.category !== undefined) {
      const fromId = (update.from_account_id as string) ?? existing.from_account_id;
      const toId = (update.to_account_id as string) ?? existing.to_account_id;
      const kind = await deriveKind(supabase, fromId, toId);
      update.category_id = kind ? await findOrCreateCategory(supabase, userId, requireString(patch.category, 'category'), kind) : null;
    }

    const { data, error } = await supabase.from('recurrences').update(update).eq('id', id).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'edit_recurring', 'recurrences', id, existing, data);
    // Regenerate all future occurrences with the new schedule terms.
    await supabase.rpc('generate_recurring_transactions', { p_recurrence_id: id });
    return data;
  },

  // Cancel a recurring item (active = false) rather than hard-delete: it stops
  // generating, drops out of the active list, and past rows that referenced it
  // stay intact.
  delete_recurring: async (supabase, userId, input) => {
    const id = requireString(input.id, 'id');
    const { data: existing, error: fetchErr } = await supabase.from('recurrences').select('*').eq('id', id).single();
    if (fetchErr || !existing) throw new Error(`Recurring item "${id}" not found`);

    const { data, error } = await supabase.from('recurrences').update({ active: false }).eq('id', id).select().single();
    if (error) throw new Error(error.message);

    await appendAudit(supabase, userId, 'delete_recurring', 'recurrences', id, existing, data);
    // Delete all future occurrences that were generated from this recurrence.
    await supabase.rpc('generate_recurring_transactions', { p_recurrence_id: id });
    return { cancelled: true, id };
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

  // Set an account's balance to a stated amount by posting the difference as a
  // transaction against an external "Balance Adjustment" account. Used by the
  // Settings reconciliation UI — intentionally NOT in writeToolDefs, so Claude's
  // create surface stays the single add_transaction tool.
  adjust_balance: async (supabase, userId, input) => {
    const account = requireString(input.account, 'account');
    const rawTarget = typeof input.target_balance === 'string' ? Number(input.target_balance) : input.target_balance;
    if (typeof rawTarget !== 'number' || !Number.isFinite(rawTarget)) {
      throw new Error(`target_balance must be a number, got: ${JSON.stringify(input.target_balance)}`);
    }
    const targetBalance = Math.round(rawTarget * 100) / 100;

    const account_id = await findOrCreateAccount(supabase, userId, account);
    const { data: acct } = await supabase.from('accounts').select('starting_balance').eq('id', account_id).single();
    const { data: postings } = await supabase.from('postings').select('delta').eq('account_id', account_id);
    const current = Number(acct?.starting_balance ?? 0) +
      (postings ?? []).reduce((sum: number, p: { delta: number }) => sum + Number(p.delta), 0);
    const delta = Math.round((targetBalance - current) * 100) / 100;
    if (delta === 0) return { adjusted: false, message: 'Balance already matches — nothing to do.' };

    const adjustId = await findOrCreateAccount(supabase, userId, 'Balance Adjustment');
    await supabase.from('accounts').update({ is_external: true }).eq('id', adjustId);

    // delta > 0 (need more) => money in: Adjustment -> account.
    // delta < 0 (too much)  => money out: account -> Adjustment.
    const from_account_id = delta > 0 ? adjustId : account_id;
    const to_account_id = delta > 0 ? account_id : adjustId;

    const { data, error } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        occurred_on: todayIso(),
        from_account_id,
        to_account_id,
        amount: Math.abs(delta),
        category_id: null,
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
      name: 'add_transaction',
      description:
        'Record money moving between two accounts (double-entry). Every transaction is FROM one account TO another. ' +
        "A purchase is from the user's own account (cash/card/bank) TO a merchant. Income is from an employer/source TO the user's account. " +
        "A transfer is between two of the user's own accounts. Whether it counts as income, expense, or transfer is figured out automatically from the accounts — you don't choose a type. " +
        'Accounts and categories are created automatically if new, so a confident guess is fine. ' +
        'Set recurring=true (with frequency and start) to set up a repeating bill/income instead of a one-time entry.',
      input_schema: {
        type: 'object',
        properties: {
          from_account: { type: 'string', description: 'Where the money comes FROM (e.g. "Chase", "cash", or an employer/merchant)' },
          to_account: { type: 'string', description: 'Where the money goes TO (e.g. a merchant like "Trader Joe\'s", or the user\'s own account)' },
          amount: { type: 'number' },
          category: { type: 'string', description: 'Optional. Only meaningful for spending/income, e.g. "Food/Drinks".' },
          date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
          note: { type: 'string' },
          recurring: { type: 'boolean', description: 'true to set up a repeating schedule instead of a one-time transaction' },
          frequency: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'yearly'], description: 'Required if recurring' },
          start: { type: 'string', description: 'YYYY-MM-DD, the next occurrence date. Required if recurring.' },
          end: { type: 'string', description: 'YYYY-MM-DD, optional end date for a recurring schedule' },
        },
        required: ['from_account', 'to_account', 'amount'],
      },
    },
    {
      name: 'edit_transaction',
      description: 'Edit an existing transaction. Look it up first to get its id.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              from_account: { type: 'string' },
              to_account: { type: 'string' },
              category: { type: 'string' },
              date: { type: 'string', description: 'YYYY-MM-DD' },
              note: { type: 'string' },
            },
          },
        },
        required: ['id', 'patch'],
      },
    },
    {
      name: 'delete_transaction',
      description: 'Delete an existing transaction. Look it up first to get its id.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'edit_recurring',
      description: 'Change an existing recurring bill/income (amount, accounts, category, frequency, or next date). Look it up first with recurring_transactions to get its id.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              from_account: { type: 'string' },
              to_account: { type: 'string' },
              category: { type: 'string' },
              frequency: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'yearly'] },
              next_on: { type: 'string', description: 'YYYY-MM-DD, the next date it hits' },
              end_on: { type: 'string', description: 'YYYY-MM-DD, optional' },
              note: { type: 'string' },
            },
          },
        },
        required: ['id', 'patch'],
      },
    },
    {
      name: 'delete_recurring',
      description: 'Cancel a recurring item (e.g. a subscription the user stopped). Look it up first with recurring_transactions to get its id.',
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
  ];
}
