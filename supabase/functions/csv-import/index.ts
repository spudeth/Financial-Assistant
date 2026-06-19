// Deterministic-first, AI-fallback-second CSV row processor. Per the
// updated design: the client parses the CSV itself and calls this function
// once per row (mode: 'process-row') — that's what drives a smooth,
// per-row progress bar client-side, and keeps each call small/fast.
//
// Per row: try deterministic parsing + find-or-create (accounts/categories
// are derivative now, so most "not found" cases just get created). Only
// rows that are *structurally* broken (bad date, zero/missing amount,
// unrecognized type) fall back to one Haiku call to reinterpret the raw
// row; if even that's unsure, the row is flagged for manual review
// (csv_import_flags + the existing Settings resolve UI).
//
// "Modified Bal." rows (a reconciliation artifact from the source app) and
// Transfer-In rows are both skipped outright — balance reconciliation now
// happens holistically after the whole import, via the adjust_balance
// write function and a per-account confirmation card in Settings, not by
// special-casing each historical Modified-Bal. row.

import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient } from '../_shared/supabaseClient.ts';
import { callClaude, toolUseBlocks, MODELS } from '../_shared/anthropic.ts';
import { findOrCreateAccount, findOrCreateCategory } from '../_shared/ledger.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

function stripEmoji(s: string): string {
  return s.replace(EMOJI_RE, '').trim();
}

function parseUsDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

type RawRow = Record<string, string>;

type Parsed = {
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  occurred_on: string;
  account: string;
  category?: string;
  counterparty_account?: string;
  payee?: string;
};

function tryDeterministicParse(raw: RawRow): { ok: true; parsed: Parsed } | { ok: false; reason: string } {
  const period = raw['Period'] ?? '';
  const accountsField = (raw['Accounts'] ?? '').trim();
  const categoryField = raw['Category'] ?? '';
  const subcategoryField = raw['Subcategory'] ?? '';
  const noteField = (raw['Note'] ?? '').trim();
  const amountField = raw['Amount'] ?? '';
  const typeField = (raw['Income/Expense'] ?? '').trim();

  const amount = Number(amountField);
  if (!amountField || Number.isNaN(amount) || amount === 0) {
    return { ok: false, reason: `Amount is missing or zero ("${amountField}")` };
  }
  const occurred_on = parseUsDate(period);
  if (!occurred_on) return { ok: false, reason: `Could not parse date "${period}" (expected MM/DD/YYYY)` };

  let type: 'income' | 'expense' | 'transfer';
  if (typeField === 'Exp.') type = 'expense';
  else if (typeField === 'Income' || typeField === 'Income Balance') type = 'income';
  else if (typeField === 'Transfer-Out') type = 'transfer';
  else return { ok: false, reason: `Unrecognized Income/Expense value "${typeField}"` };

  if (!accountsField) return { ok: false, reason: 'Account name is blank' };

  if (type === 'transfer') {
    const destName = stripEmoji(categoryField);
    if (!destName) return { ok: false, reason: 'Transfer-Out has no destination account in the Category column' };
    return { ok: true, parsed: { type, amount: Math.abs(amount), occurred_on, account: accountsField, counterparty_account: destName, payee: noteField || undefined } };
  }

  const category = subcategoryField ? `${stripEmoji(categoryField)} > ${stripEmoji(subcategoryField)}` : stripEmoji(categoryField);
  if (!category) return { ok: false, reason: 'Category is blank' };

  return { ok: true, parsed: { type, amount: Math.abs(amount), occurred_on, account: accountsField, category, payee: noteField || undefined } };
}

const AI_FALLBACK_TOOLS = [
  {
    name: 'interpret_row',
    description: 'Confidently reinterpret this CSV row as a transaction.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['income', 'expense', 'transfer'] },
        amount: { type: 'number', description: 'Always positive' },
        occurred_on: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string' },
        category: { type: 'string', description: 'Required unless type is transfer. "Parent" or "Parent > Child".' },
        counterparty_account: { type: 'string', description: 'Required if type is transfer' },
        payee: { type: 'string' },
      },
      required: ['type', 'amount', 'occurred_on', 'account'],
    },
  },
  {
    name: 'mark_unsure',
    description: 'This row cannot be confidently interpreted as a transaction.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

async function aiReinterpret(raw: RawRow, structuralReason: string): Promise<{ ok: true; parsed: Parsed } | { ok: false; reason: string }> {
  const resp = await callClaude({
    model: MODELS.router,
    system: 'You are a function that reinterprets one malformed CSV row from a personal-finance export into a transaction. Call interpret_row if you can determine type/amount/date/account confidently, otherwise call mark_unsure with why.',
    messages: [{ role: 'user', content: `Row: ${JSON.stringify(raw)}\nDeterministic parsing failed because: ${structuralReason}` }],
    tools: AI_FALLBACK_TOOLS,
    tool_choice: { type: 'any' },
    max_tokens: 300,
  });

  const calls = toolUseBlocks(resp.content);
  if (calls.length === 0) return { ok: false, reason: structuralReason };
  const call = calls[0];
  if (call.name === 'mark_unsure') return { ok: false, reason: (call.input.reason as string) ?? structuralReason };

  const input = call.input as Record<string, unknown>;
  return {
    ok: true,
    parsed: {
      type: input.type as Parsed['type'],
      amount: Math.abs(Number(input.amount)),
      occurred_on: input.occurred_on as string,
      account: input.account as string,
      category: input.category as string | undefined,
      counterparty_account: input.counterparty_account as string | undefined,
      payee: input.payee as string | undefined,
    },
  };
}

async function insertParsed(supabase: SupabaseClient, userId: string, parsed: Parsed) {
  const account_id = await findOrCreateAccount(supabase, userId, parsed.account);
  let counterparty_account_id: string | null = null;
  let category_id: string | null = null;

  if (parsed.type === 'transfer') {
    if (!parsed.counterparty_account) throw new Error('Transfer has no destination account');
    counterparty_account_id = await findOrCreateAccount(supabase, userId, parsed.counterparty_account);
  } else {
    if (!parsed.category) throw new Error('Missing category');
    category_id = await findOrCreateCategory(supabase, userId, parsed.category, parsed.type);
  }

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: userId,
      occurred_on: parsed.occurred_on,
      type: parsed.type,
      amount: parsed.amount,
      account_id,
      counterparty_account_id,
      category_id,
      payee: parsed.payee ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const supabase = createUserClient(req);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return withCors({ error: 'Not authenticated' }, { status: 401 });
    const userId = userData.user.id;

    if (body.mode === 'process-row' || body.mode === 'resolve') {
      const raw = { ...(body.row as RawRow), ...((body.overrides as RawRow) ?? {}) };

      const typeField = (raw['Income/Expense'] ?? '').trim();
      if (typeField === 'Transfer-In') return withCors({ result: 'skipped', reason: 'Transfer-In (captured by the matching Transfer-Out row)' });
      if (stripEmoji(raw['Category'] ?? '') === 'Modified Bal.') {
        return withCors({ result: 'skipped', reason: 'Reconciliation entry from the source app — check your account balances after import finishes' });
      }

      let parseResult = tryDeterministicParse(raw);
      let viaAi = false;
      if (!parseResult.ok && body.mode === 'process-row') {
        parseResult = await aiReinterpret(raw, parseResult.reason);
        viaAi = parseResult.ok;
      }

      if (!parseResult.ok) {
        if (body.mode === 'resolve') {
          return withCors({ result: 'still-flagged', reason: parseResult.reason });
        }
        const { data: flagRow } = await supabase
          .from('csv_import_flags').insert({ user_id: userId, raw_row: raw, reason: parseResult.reason }).select('id').single();
        return withCors({ result: 'flagged', flagId: flagRow?.id, reason: parseResult.reason });
      }

      const inserted = await insertParsed(supabase, userId, parseResult.parsed);
      if (body.flagId) await supabase.from('csv_import_flags').update({ resolved: true }).eq('id', body.flagId);
      return withCors({ result: viaAi ? 'ai-resolved' : 'imported', row: inserted });
    }

    return withCors({ error: 'mode must be "process-row" or "resolve"' }, { status: 400 });
  } catch (e) {
    console.error(e);
    return withCors({ error: (e as Error).message }, { status: 400 });
  }
});
