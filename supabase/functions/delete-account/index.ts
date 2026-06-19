// Deletes the calling user's account entirely. Needs the service role key
// because no user-scoped client can delete its own auth.users row — that's
// why this is the one edge function allowed to use createServiceClient().
// Every owned table has `on delete cascade` to auth.users(id), so deleting
// the auth user wipes accounts/categories/transactions/conversations/etc.
// in one step; nothing else needs to be deleted manually.

import { corsHeaders, withCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient } from '../_shared/supabaseClient.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const callerClient = createUserClient(req);
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return withCors({ error: 'Not authenticated' }, { status: 401 });

    const service = createServiceClient();
    const { error } = await service.auth.admin.deleteUser(userData.user.id);
    if (error) throw new Error(error.message);

    return withCors({ deleted: true });
  } catch (e) {
    console.error(e);
    return withCors({ error: (e as Error).message }, { status: 400 });
  }
});
