// Handles the CONFIRM flow's two server-side outcomes: accept (execute the
// write) and edit (single-shot micro-agent patch, no conversation history).
// Reject is handled entirely client-side and never reaches this function.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient } from '../_shared/supabaseClient.ts';
import { callClaude, toolUseBlocks, MODELS } from '../_shared/anthropic.ts';
import { buildEditPrompt, fetchVocab } from '../_shared/prompts.ts';
import { exact } from '../_shared/ledger.ts';
import { writeRegistry, writeToolDefs } from '../_shared/writeRegistry.ts';

// Soft duplicate guard: if the user is about to log an expense/income that
// exactly matches one already on the books (same amount + date + account),
// warn them instead of saving. Never blocks — the client re-sends with
// force=true to add it anyway. Only the common log case; transfers/edits/etc.
// are not checked.
async function duplicateWarning(
  supabase: SupabaseClient,
  userId: string,
  intent: Record<string, unknown>,
): Promise<string | null> {
  const name = intent.intent;
  if (name !== 'add_expense' && name !== 'add_income') return null;

  const amount = Math.round(Number(intent.amount) * 100) / 100;
  if (!Number.isFinite(amount)) return null;
  const date = (typeof intent.date === 'string' && intent.date) || new Date().toISOString().slice(0, 10);
  const accountName = typeof intent.account === 'string' ? intent.account.trim() : '';
  if (!accountName) return null;

  // Unknown account → let the write handler surface that, not a dup warning.
  const { data: acct } = await supabase.from('accounts').select('id, name').ilike('name', exact(accountName)).maybeSingle();
  if (!acct) return null;

  const type = name === 'add_expense' ? 'expense' : 'income';
  const { data: matches } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .eq('occurred_on', date)
    .eq('account_id', acct.id)
    .eq('amount', amount);

  if (matches && matches.length > 0) {
    return `Looks like you already logged $${amount} on ${acct.name} for ${date}.`;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { intent, action, editInstruction, force } = await req.json();
    if (!intent || typeof intent !== 'object' || !intent.intent) {
      return withCors({ error: 'intent (with an "intent" field naming the write function) is required' }, { status: 400 });
    }

    const supabase = createUserClient(req);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return withCors({ error: 'Not authenticated' }, { status: 401 });
    const userId = userData.user.id;

    if (action === 'accept') {
      const { intent: intentName, ...fields } = intent;
      const handler = writeRegistry[intentName];
      if (!handler) return withCors({ error: `Unknown write function "${intentName}"` }, { status: 400 });

      if (!force) {
        const warning = await duplicateWarning(supabase, userId, intent);
        if (warning) return withCors({ executed: false, duplicate: true, message: warning });
      }

      const result = await handler(supabase, userId, fields);
      return withCors({ executed: true, result });
    }

    if (action === 'edit') {
      if (!editInstruction || typeof editInstruction !== 'string') {
        return withCors({ error: 'editInstruction is required for action "edit"' }, { status: 400 });
      }
      const { intent: intentName, ...fields } = intent;
      const { accounts, categories } = await fetchVocab(supabase);
      const resp = await callClaude({
        model: MODELS.main,
        system: buildEditPrompt(accounts, categories),
        messages: [
          { role: 'user', content: `Current intent (tool: ${intentName}):\n${JSON.stringify(fields)}\n\nEdit instruction: ${editInstruction}` },
        ],
        tools: writeToolDefs(),
        tool_choice: { type: 'tool', name: intentName },
      });

      const calls = toolUseBlocks(resp.content);
      if (calls.length === 0) return withCors({ error: 'Could not apply that edit — try rephrasing it.' }, { status: 400 });

      const patched = { intent: calls[0].name, ...calls[0].input };
      return withCors({ executed: false, intent: patched });
    }

    return withCors({ error: 'action must be "accept" or "edit"' }, { status: 400 });
  } catch (e) {
    console.error(e);
    return withCors({ error: (e as Error).message }, { status: 400 });
  }
});
