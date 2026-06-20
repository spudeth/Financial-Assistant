import { supabase } from './supabase';

export type PendingIntent = { intent: string; [field: string]: unknown };
export type PendingClassification = { id: string; name: string };

export type ChatResponse = {
  reply: string;
  conversationId: string;
  pendingIntents: PendingIntent[];
  pendingClassifications: PendingClassification[];
};

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as T;
}

export function sendChatMessage(message: string, conversationId?: string): Promise<ChatResponse> {
  return invoke<ChatResponse>('chat', { message, conversationId });
}

export type AcceptResult =
  | { executed: true; result: unknown }
  | { executed: false; duplicate: true; message: string };

// force=true skips the soft duplicate check (the "add anyway" path).
export function acceptIntent(intent: PendingIntent, force = false): Promise<AcceptResult> {
  return invoke('confirm', { intent, action: 'accept', force });
}

export function editIntent(intent: PendingIntent, editInstruction: string): Promise<{ executed: false; intent: PendingIntent }> {
  return invoke('confirm', { intent, action: 'edit', editInstruction });
}

export type CsvRowResult =
  | { result: 'imported' | 'ai-resolved'; row: unknown }
  | { result: 'skipped'; reason: string }
  | { result: 'flagged'; flagId: string; reason: string }
  | { result: 'still-flagged'; reason: string };

// One row per call — this is what drives the per-row progress bar
// client-side (processed/total), and lets the bar visibly slow down on
// rows that need the AI fallback instead of jumping in two disconnected phases.
export function processCsvRow(row: Record<string, string>): Promise<CsvRowResult> {
  return invoke('csv-import', { mode: 'process-row', row });
}

export function resolveCsvRow(
  flagId: string,
  row: Record<string, string>,
  overrides: Record<string, string>
): Promise<CsvRowResult> {
  return invoke('csv-import', { mode: 'resolve', row, overrides, flagId });
}

export async function deleteAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account', { body: {} });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
}

// Wipes financial data only (transactions/recurrences/budgets/categories/
// accounts/csv flags) — keeps the login and chat history intact. Plain
// RLS-scoped deletes, no edge function needed since the user can only ever
// touch their own rows.
export async function deleteMyData(): Promise<void> {
  const tables = ['transactions', 'recurrences', 'budgets', 'categories', 'accounts', 'csv_import_flags'];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().not('id', 'is', null);
    if (error) throw error;
  }
}

// Account-type classification is a plain RLS-scoped update — no edge
// function needed, Claude is never involved in this decision.
export async function classifyAccount(accountId: string, groupType: string, isLiability: boolean): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ group_type: groupType, is_liability: isLiability })
    .eq('id', accountId);
  if (error) throw error;
}
