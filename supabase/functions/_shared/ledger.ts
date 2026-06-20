// Shared find-or-create helpers. Accounts and categories are derivative of
// the ledger now — nothing is pre-seeded. CSV import and chat-driven writes
// both use findOrCreateAccount/findOrCreateCategory freely — a guessed
// account/category is fine because nothing commits until the user approves
// the confirm card. writeRegistry.ts's lookupAccountId is still used for
// patching an existing record's account (edit_recurring/edit_transaction),
// where find-or-throw is the safer default.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { categoryNameParts } from './vocab.ts';

// Case-insensitive exact match — real-world names don't reliably match
// casing, and there's no reason a real account/category name would contain
// SQL wildcard characters.
export function exact(name: string): string {
  return name.replace(/[%_]/g, '\\$&');
}

export async function findOrCreateAccount(supabase: SupabaseClient, userId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  const { data: existing } = await supabase.from('accounts').select('id').ilike('name', exact(trimmed)).maybeSingle();
  if (existing) return existing.id;

  // account_type_hints.pattern is a substring to look for *within* the
  // account name (e.g. pattern "chase" matches account "Chase Checking") —
  // that direction can't be expressed as a single ilike() filter since the
  // wildcard needs the column's own value on both sides, so it's done
  // client-side against the (small, ~30-row) hints table instead.
  const { data: hints } = await supabase.from('account_type_hints').select('pattern, group_type, is_liability');
  const lowerName = trimmed.toLowerCase();
  const hint = (hints ?? [])
    .filter((h) => lowerName.includes(h.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];

  const { data: created, error } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      name: trimmed,
      group_type: hint?.group_type ?? null,
      is_liability: hint?.is_liability ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Could not create account "${trimmed}": ${error.message}`);
  return created.id;
}

export async function findOrCreateCategory(
  supabase: SupabaseClient,
  userId: string,
  categoryPath: string,
  kind: 'income' | 'expense'
): Promise<string> {
  const { parent, child } = categoryNameParts(categoryPath);

  let parentId: string;
  const { data: existingParent } = await supabase
    .from('categories').select('id').ilike('name', exact(parent)).eq('kind', kind).is('parent_id', null).maybeSingle();
  if (existingParent) {
    parentId = existingParent.id;
  } else {
    const { data: createdParent, error } = await supabase
      .from('categories').insert({ user_id: userId, name: parent, kind }).select('id').single();
    if (error) throw new Error(`Could not create category "${parent}": ${error.message}`);
    parentId = createdParent.id;
  }

  if (!child) return parentId;

  const { data: existingChild } = await supabase
    .from('categories').select('id').ilike('name', exact(child)).eq('kind', kind).eq('parent_id', parentId).maybeSingle();
  if (existingChild) return existingChild.id;

  const { data: createdChild, error } = await supabase
    .from('categories').insert({ user_id: userId, name: child, parent_id: parentId, kind }).select('id').single();
  if (error) throw new Error(`Could not create category "${categoryPath}": ${error.message}`);
  return createdChild.id;
}
