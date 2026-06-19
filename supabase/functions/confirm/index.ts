// Handles the CONFIRM flow's two server-side outcomes: accept (execute the
// write) and edit (single-shot micro-agent patch, no conversation history).
// Reject is handled entirely client-side and never reaches this function.

import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient } from '../_shared/supabaseClient.ts';
import { callClaude, toolUseBlocks, MODELS } from '../_shared/anthropic.ts';
import { buildEditPrompt, fetchVocab } from '../_shared/prompts.ts';
import { writeRegistry, writeToolDefs } from '../_shared/writeRegistry.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { intent, action, editInstruction } = await req.json();
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
