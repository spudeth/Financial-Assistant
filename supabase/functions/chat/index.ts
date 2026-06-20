// One assistant, one tool-use loop. A single persona sees both read and write
// tools and decides what to do — no router, no separate flows. Reads run here;
// writes are collected as unexecuted intents the client must send to /confirm.
// This function NEVER writes to the database.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient } from '../_shared/supabaseClient.ts';
import { callClaude, firstText, toolUseBlocks, MODELS } from '../_shared/anthropic.ts';
import { buildChatPrompt, buildMemoryPrompt, fetchVocab } from '../_shared/prompts.ts';
import { readRegistry, readToolDefs } from '../_shared/readRegistry.ts';
import { writeRegistry, writeToolDefs } from '../_shared/writeRegistry.ts';

// Background memory-writer: after the reply is sent, a cheap call rewrites the
// user's compact profile from the latest exchange (Option A — full self-rewrite
// under a size budget). Failures are swallowed; this must never affect chat.
async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  currentProfile: string,
  userMessage: string,
  reply: string,
) {
  try {
    const resp = await callClaude({
      model: MODELS.memory,
      system: buildMemoryPrompt(currentProfile),
      messages: [{ role: 'user', content: `User said: ${userMessage}\nAssistant replied: ${reply}` }],
      max_tokens: 700,
    });
    const next = firstText(resp.content).trim();
    if (!next) return;
    await supabase.from('profiles').upsert({ user_id: userId, content: next, updated_at: new Date().toISOString() });
  } catch (e) {
    console.error('profile update failed', e);
  }
}

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

    // ── One assistant, one loop ──
    // The model is a single persona that sees read AND write tools and decides
    // what to do. Reads run here and feed back into the loop (one at a time).
    // Writes are NEVER executed here — each becomes a pending confirmation the
    // client must send to /confirm. So emitting a write call == proposing a card.
    const { accounts, categories } = await fetchVocab(supabase);
    const todayIso = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: recent } = await supabase.rpc('transaction_search', {
      p_filters: { start_date: thirtyDaysAgo, end_date: todayIso },
    });

    const { data: profileRow } = await supabase.from('profiles').select('content').eq('user_id', userId).maybeSingle();
    const profile = profileRow?.content ?? '';
    const system = buildChatPrompt(accounts, categories, profile);
    const tools = [...readToolDefs(), ...writeToolDefs()];

    let messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      ...history,
      {
        role: 'user',
        content: `Today's date: ${todayIso}\nRecent transactions (last 30 days):\n${JSON.stringify(recent)}\n\n${message}`,
      },
    ];

    const pendingIntents: Record<string, unknown>[] = [];
    let resp = await callClaude({ model: MODELS.main, system, messages, tools, tool_choice: { type: 'auto' } });

    let guard = 0;
    while (resp.stop_reason === 'tool_use' && guard < 5) {
      guard++;
      const calls = toolUseBlocks(resp.content);

      // Every write call is collected as a pending confirmation, never run here.
      for (const call of calls) {
        if (writeRegistry[call.name]) pendingIntents.push({ intent: call.name, ...call.input });
      }

      // Writes-only response: the model's reply text is already here — no extra
      // round trip needed. Stop and return what it said + the cards.
      const hasReads = calls.some((c) => readRegistry[c.name]);
      if (!hasReads) break;

      // Otherwise answer every tool call so the loop can continue: run the ONE
      // allowed read, acknowledge writes, reject surplus reads + unknown tools.
      let readsUsed = 0;
      const toolResults = await Promise.all(
        calls.map(async (call) => {
          if (writeRegistry[call.name]) {
            return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ status: 'shown_to_user_for_confirmation' }) };
          }
          if (readRegistry[call.name]) {
            if (readsUsed >= 1) {
              return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ error: 'Only one read per turn — make a single read call.' }), is_error: true };
            }
            readsUsed++;
            try {
              const result = await readRegistry[call.name].call(supabase, call.input);
              return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
            } catch (e) {
              return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ error: (e as Error).message }), is_error: true };
            }
          }
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ error: `Unknown tool "${call.name}"` }), is_error: true };
        }),
      );

      messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
      resp = await callClaude({ model: MODELS.main, system, messages, tools, tool_choice: { type: 'auto' } });
    }

    const reply = firstText(resp.content) || (pendingIntents.length ? 'Done.' : "I'm here — what's up?");

    await supabase.from('messages').insert({ conversation_id: convoId, user_id: userId, role: 'assistant', content: reply });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', convoId);

    // Refresh the profile in the background so it never delays the reply. On
    // platforms without the after-response hook, fall back to awaiting it.
    const memoryTask = updateProfile(supabase, userId, profile, message, reply);
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(memoryTask);
    else await memoryTask;

    return withCors({ reply, conversationId: convoId, pendingIntents, pendingClassifications });
  } catch (e) {
    console.error(e);
    return withCors({ error: (e as Error).message }, { status: 400 });
  }
});
