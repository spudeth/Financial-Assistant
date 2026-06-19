// Orchestrates the three-flow architecture from Final Phase Context.md:
// routes the message as READ / WRITE / CONVERSATIONAL, then handles it.
// This function NEVER writes to the database — WRITE produces an
// unexecuted intent object that the client must send to /confirm.

import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient } from '../_shared/supabaseClient.ts';
import { callClaude, firstText, toolUseBlocks, MODELS } from '../_shared/anthropic.ts';
import { buildReadPrompt, buildWritePrompt, CONVERSATIONAL_PROMPT, fetchVocab, ROUTING_PROMPT } from '../_shared/prompts.ts';
import { readRegistry, readToolDefs } from '../_shared/readRegistry.ts';
import { writeToolDefs } from '../_shared/writeRegistry.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { message, conversationId } = await req.json();
    if (!message || typeof message !== 'string' || !message.trim()) {
      return withCors({ error: 'message is required' }, { status: 400 });
    }

    const supabase = createUserClient(req);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return withCors({ error: 'Not authenticated' }, { status: 401 });
    const userId = userData.user.id;

    // Resolve (or create) the conversation this message belongs to.
    let convoId = conversationId as string | undefined;
    if (!convoId) {
      const { data: convo, error: convoErr } = await supabase
        .from('conversations')
        .insert({ user_id: userId, title: message.slice(0, 60) })
        .select('id')
        .single();
      if (convoErr) throw new Error(convoErr.message);
      convoId = convo.id;
    }

    await supabase.from('messages').insert({ conversation_id: convoId, user_id: userId, role: 'user', content: message });

    // Recent history for conversational/READ context (last 20 turns).
    const { data: historyRows } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', convoId)
      .order('created_at', { ascending: false })
      .limit(20);
    const history = (historyRows ?? []).reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Accounts still missing a type get surfaced as classification prompts,
    // independent of whatever the user actually asked about.
    const { data: unclassified } = await supabase.rpc('unclassified_accounts');
    const pendingClassifications = (unclassified ?? []) as Array<{ id: string; name: string }>;

    // ── Step 1: route intent (cheap, separate call) ──
    const routeResp = await callClaude({
      model: MODELS.router,
      system: ROUTING_PROMPT,
      messages: [{ role: 'user', content: message }],
      max_tokens: 10,
    });
    const bucket = firstText(routeResp.content).trim().toUpperCase();

    let reply = '';
    let pendingIntent: Record<string, unknown> | null = null;

    if (bucket === 'READ') {
      const { accounts, categories } = await fetchVocab(supabase);
      const todayIso = new Date().toISOString().slice(0, 10);
      const readSystem = buildReadPrompt(accounts, categories, todayIso);
      let messages = [...history, { role: 'user' as const, content: message }];
      // Force a tool call on the first turn — otherwise nothing stops Claude
      // from answering straight out of `history` (which may already contain
      // a stale figure from an earlier reply) instead of querying fresh data.
      let resp = await callClaude({
        model: MODELS.main,
        system: readSystem,
        messages,
        tools: readToolDefs(),
        tool_choice: { type: 'any' },
      });

      let guard = 0;
      while (resp.stop_reason === 'tool_use' && guard < 4) {
        guard++;
        const calls = toolUseBlocks(resp.content);
        const toolResults = [];
        for (const call of calls) {
          const entry = readRegistry[call.name];
          let result: unknown;
          try {
            result = entry ? await entry.call(supabase, call.input) : { error: `Unknown read function "${call.name}"` };
          } catch (e) {
            result = { error: (e as Error).message };
          }
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
        }
        messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
        resp = await callClaude({ model: MODELS.main, system: readSystem, messages, tools: readToolDefs() });
      }
      reply = firstText(resp.content) || "Couldn't answer that with the available data.";
    } else if (bucket === 'WRITE') {
      const { accounts, categories } = await fetchVocab(supabase);
      const writeSystem = buildWritePrompt(accounts, categories);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const todayIso = new Date().toISOString().slice(0, 10);
      const { data: recent } = await supabase.rpc('transaction_search', {
        p_filters: { start_date: thirtyDaysAgo, end_date: todayIso },
      });

      const writeMessages = [
        ...history,
        { role: 'user' as const, content: `Today's date: ${todayIso}\nUser's last 30 days of transactions:\n${JSON.stringify(recent)}\n\nUser message: ${message}` },
      ];
      const resp = await callClaude({ model: MODELS.main, system: writeSystem, messages: writeMessages, tools: writeToolDefs() });

      const calls = toolUseBlocks(resp.content);
      if (calls.length > 0) {
        const call = calls[0];
        pendingIntent = { intent: call.name, ...call.input };
        reply = firstText(resp.content) || `${call.name}: ${JSON.stringify(call.input)}`;
      } else {
        reply = firstText(resp.content) || 'Need more detail to log that.';
      }
    } else {
      const messages = [...history, { role: 'user' as const, content: message }];
      const resp = await callClaude({ model: MODELS.main, system: CONVERSATIONAL_PROMPT, messages });
      reply = firstText(resp.content) || "I'm here — what's up?";
    }

    await supabase.from('messages').insert({ conversation_id: convoId, user_id: userId, role: 'assistant', content: reply });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', convoId);

    return withCors({ reply, conversationId: convoId, pendingIntent, pendingClassifications });
  } catch (e) {
    console.error(e);
    return withCors({ error: (e as Error).message }, { status: 400 });
  }
});
