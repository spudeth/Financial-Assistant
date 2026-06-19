// Read function registry. Each entry wraps one Postgres function (defined
// in the init_engine migration) and the JSON-Schema tool definition Claude
// sees. Adding a new read function later = write the SQL function, add one
// entry here, done — nothing else changes.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

type ReadEntry = {
  description: string;
  input_schema: Record<string, unknown>;
  call: (supabase: SupabaseClient, input: Record<string, unknown>) => Promise<unknown>;
};

export const readRegistry: Record<string, ReadEntry> = {
  category_breakdown: {
    description: 'Breakdown by category over a date range, with each category\'s amount and % of its type\'s total. Pass type to scope it to income, expense, or transfer; omit type to get all of them together.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        type: { type: 'string', enum: ['income', 'expense', 'transfer'], description: 'Optional: limit to one transaction type. Omit for all types.' },
      },
      required: ['start_date', 'end_date'],
    },
    call: async (supabase, input) => {
      const { data, error } = await supabase.rpc('category_breakdown', {
        p_start: input.start_date,
        p_end: input.end_date,
        p_type: input.type ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },
  },

  budget_vs_actual: {
    description: 'Monthly budget vs actual spend, per category.',
    input_schema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'Any date within the target month, YYYY-MM-DD' } },
      required: ['month'],
    },
    call: async (supabase, input) => {
      const { data, error } = await supabase.rpc('budget_vs_actual', { p_month: input.month });
      if (error) throw new Error(error.message);
      return data;
    },
  },

  period_totals: {
    description: 'Income/expense/net totals bucketed by day, week, or month over a date range. Use this for "how much came in vs went out", "what does my spending look like over time", or any totals-over-time question.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        granularity: { type: 'string', enum: ['day', 'week', 'month'], description: 'How to bucket the range. Defaults to month.' },
      },
      required: ['start_date', 'end_date'],
    },
    call: async (supabase, input) => {
      const { data, error } = await supabase.rpc('period_totals', {
        p_start: input.start_date,
        p_end: input.end_date,
        p_granularity: input.granularity ?? 'month',
      });
      if (error) throw new Error(error.message);
      return data;
    },
  },

  accounts_overview: {
    description: 'Current balance of every active account, plus total assets, liabilities, and net worth. Use this for "where do I stand" / balance / net worth questions.',
    input_schema: { type: 'object', properties: {} },
    call: async (supabase) => {
      const { data, error } = await supabase.rpc('accounts_overview');
      if (error) throw new Error(error.message);
      return data;
    },
  },

  account_ledger: {
    description: 'Running balance history for one account over a date range.',
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Exact account name' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['account', 'start_date', 'end_date'],
    },
    call: async (supabase, input) => {
      const { data, error } = await supabase.rpc('account_ledger', {
        p_account_name: input.account,
        p_start: input.start_date,
        p_end: input.end_date,
      });
      if (error) throw new Error(error.message);
      return data;
    },
  },

  recurring_transactions: {
    description: 'List all active recurring transactions (subscriptions, bills, repeating income) with their frequency and next date.',
    input_schema: { type: 'object', properties: {} },
    call: async (supabase) => {
      const { data, error } = await supabase.rpc('recurring_transactions');
      if (error) throw new Error(error.message);
      return data;
    },
  },

  transaction_search: {
    description: 'Search transactions by account, category, type, payee, and/or date range. Returns a flat matching list, or pass group_by to bucket the results by day/week/month with subtotals (use this for "what happened on X" / transaction history questions).',
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        category: { type: 'string' },
        type: { type: 'string', enum: ['income', 'expense', 'transfer'] },
        payee: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        group_by: { type: 'string', enum: ['day', 'week', 'month'], description: 'Optional: bucket results instead of returning a flat list.' },
      },
    },
    call: async (supabase, input) => {
      const { data, error } = await supabase.rpc('transaction_search', { p_filters: input });
      if (error) throw new Error(error.message);
      return data;
    },
  },
};

export function readToolDefs() {
  return Object.entries(readRegistry).map(([name, entry]) => ({
    name,
    description: entry.description,
    input_schema: entry.input_schema,
  }));
}
