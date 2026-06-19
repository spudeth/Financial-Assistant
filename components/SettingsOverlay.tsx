import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, PanResponder, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { colors, spacing, radius } from '../theme/theme';
import { supabase } from '../lib/supabase';
import { signOut } from '../lib/auth';
import { deleteAccount, deleteMyData } from '../lib/api';

const SWIPE_THRESHOLD = 60;

type FlaggedRow = { id: string; reason: string; raw: Record<string, string> };
type ReconciliationCard = { account: string; computedBalance: number };

function SectionTitle({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm, marginTop: spacing.lg }}>
      {children}
    </Text>
  );
}

function ActionButton({ label, onPress, tone = 'default', disabled }: { label: string; onPress: () => void; tone?: 'default' | 'primary' | 'danger'; disabled?: boolean }) {
  const bg = tone === 'primary' ? colors.primary : tone === 'danger' ? 'rgba(255,90,90,0.18)' : colors.surfaceAlt;
  const fg = tone === 'primary' ? colors.background : tone === 'danger' ? '#ff6b6b' : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{ backgroundColor: bg, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center', marginBottom: spacing.sm, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: fg, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function formatPeriod(occurredOn: string): string {
  const [y, m, d] = occurredOn.split('-');
  return `${m}/${d}/${y}`;
}

type Props = {
  onClose: () => void;
  importState: {
    importing: boolean;
    progress: { processed: number; total: number } | null;
    importSummary: { imported: number; skipped: number; aiResolved: number } | null;
    flaggedRows: FlaggedRow[];
    resolveDrafts: Record<string, { accountName: string; category: string }>;
    reconciliation: ReconciliationCard[];
    reconcileDrafts: Record<string, string>;
  };
  setImportState: (update: (prev: any) => any) => void;
  onImportCsv: () => void;
  onResolveRow: (flagId: string, raw: Record<string, string>) => Promise<void>;
  onDismissReconciliation: (account: string) => void;
  onCorrectBalance: (account: string) => Promise<void>;
};

export default function SettingsOverlay({
  onClose,
  importState,
  setImportState,
  onImportCsv,
  onResolveRow,
  onDismissReconciliation,
  onCorrectBalance,
}: Props) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirming' | 'deleting'>('idle');
  const [deleteDataStep, setDeleteDataStep] = useState<'idle' | 'confirming' | 'deleting'>('idle');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? '');
      setFullName((data.user?.user_metadata?.full_name as string) ?? '');
    });
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 20 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > SWIPE_THRESHOLD) {
          onClose();
        }
      },
    })
  ).current;

  async function handleSaveName() {
    setSavingName(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: fullName } });
      if (error) throw error;
      Alert.alert('Saved', 'Your name has been updated.');
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    } finally {
      setSavingName(false);
    }
  }

  async function handleSavePassword() {
    if (newPassword.length < 6) {
      Alert.alert('Too short', 'Password must be at least 6 characters.');
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword('');
      Alert.alert('Saved', 'Your password has been changed.');
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleDownloadData() {
    setExporting(true);
    try {
      const [{ data: txns, error: txErr }, { data: accounts, error: accErr }, { data: categories, error: catErr }] = await Promise.all([
        supabase.from('transactions').select('occurred_on, type, amount, account_id, counterparty_account_id, category_id, payee'),
        supabase.from('accounts').select('id, name'),
        supabase.from('categories').select('id, name, parent_id'),
      ]);
      if (txErr) throw txErr;
      if (accErr) throw accErr;
      if (catErr) throw catErr;

      const accountName = new Map((accounts ?? []).map((a) => [a.id, a.name]));
      const catById = new Map((categories ?? []).map((c) => [c.id, c]));
      const categoryPath = (id: string | null) => {
        if (!id) return { parent: '', child: '' };
        const cat = catById.get(id);
        if (!cat) return { parent: '', child: '' };
        if (!cat.parent_id) return { parent: cat.name, child: '' };
        const parent = catById.get(cat.parent_id);
        return { parent: parent?.name ?? '', child: cat.name };
      };

      const rows: string[][] = [['Period', 'Account', 'Category', 'Subcategory', 'Note', 'Amount', 'Type', 'Description']];
      for (const t of txns ?? []) {
        const period = formatPeriod(t.occurred_on);
        const note = t.payee ?? '';
        if (t.type === 'transfer') {
          rows.push([period, accountName.get(t.account_id) ?? '', '', '', note, String(t.amount), 'Transfer-Out', '']);
          rows.push([period, accountName.get(t.counterparty_account_id) ?? '', '', '', note, String(t.amount), 'Transfer-In', '']);
        } else if (t.type === 'adjustment') {
          rows.push([period, accountName.get(t.account_id) ?? '', '', '', note, String(t.amount), 'Adjustment', '']);
        } else {
          const { parent, child } = categoryPath(t.category_id);
          const type = t.type === 'expense' ? 'Exp.' : 'Income';
          rows.push([period, accountName.get(t.account_id) ?? '', parent, child, note, String(t.amount), type, '']);
        }
      }

      const csv = rows.map((r) => r.map(csvField).join(',')).join('\n');
      const uri = FileSystem.documentDirectory + 'financial-assistant-export.csv';
      await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(uri, { mimeType: 'text/csv' });
    } catch (e) {
      Alert.alert('Export failed', (e as Error).message);
    } finally {
      setExporting(false);
    }
  }


  async function handleLogout() {
    await signOut();
    router.replace('/');
  }

  async function handleDeleteAccount() {
    setDeleteStep('deleting');
    try {
      await deleteAccount();
      router.replace('/');
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
      setDeleteStep('idle');
    }
  }

  async function handleDeleteMyData() {
    setDeleteDataStep('deleting');
    try {
      await deleteMyData();
      setImportState((prev) => ({ ...prev, importSummary: null, flaggedRows: [], reconciliation: [] }));
      Alert.alert('Done', 'Your financial data has been deleted. Your login and chat history are unaffected.');
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    } finally {
      setDeleteDataStep('idle');
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 56 }} {...panResponder.panHandlers}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, marginBottom: spacing.md }}>
        <Pressable
          onPress={onClose}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: colors.text, fontSize: 18 }}>‹</Text>
        </Pressable>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginLeft: spacing.md }}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xl }}>
        <SectionTitle>Profile</SectionTitle>
        <Text style={{ color: colors.textMuted, fontSize: 13, marginBottom: spacing.sm }}>{email}</Text>
        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your name"
          placeholderTextColor={colors.textMuted}
          keyboardAppearance="dark"
          style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, color: colors.text, padding: 12, marginBottom: spacing.sm }}
        />
        <ActionButton label={savingName ? 'Saving…' : 'Save name'} onPress={handleSaveName} disabled={savingName} />

        <TextInput
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="New password"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          keyboardAppearance="dark"
          style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, color: colors.text, padding: 12, marginBottom: spacing.sm }}
        />
        <ActionButton label={savingPassword ? 'Saving…' : 'Change password'} onPress={handleSavePassword} disabled={savingPassword} />

        <SectionTitle>Your data</SectionTitle>
        <ActionButton label={exporting ? 'Preparing…' : 'Download my data (CSV)'} onPress={handleDownloadData} disabled={exporting} />
        <ActionButton label={importState.importing ? 'Importing…' : 'Import CSV from Money Manager'} onPress={onImportCsv} disabled={importState.importing} />

        {importState.progress && (
          <View style={{ marginBottom: spacing.sm }}>
            <View style={{ height: 6, backgroundColor: colors.surfaceAlt, borderRadius: radius.full, overflow: 'hidden' }}>
              <View
                style={{
                  height: 6,
                  backgroundColor: colors.primary,
                  width: `${importState.progress.total ? Math.round((importState.progress.processed / importState.progress.total) * 100) : 0}%`,
                }}
              />
            </View>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
              {importState.progress.processed} / {importState.progress.total} rows
            </Text>
          </View>
        )}

        {importState.importSummary && (
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text }}>
              {importState.importSummary.imported} imported{importState.importSummary.aiResolved ? ` (${importState.importSummary.aiResolved} via AI fallback)` : ''}, {importState.flaggedRows.length} flagged for review
              {importState.importSummary.skipped ? `, ${importState.importSummary.skipped} skipped` : ''}.
            </Text>
          </View>
        )}

        {importState.reconciliation.map((card) => (
          <View key={card.account} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text, fontSize: 13, marginBottom: 8 }}>
              <Text style={{ fontWeight: '700' }}>{card.account}</Text> computes to ${card.computedBalance.toFixed(2)} from the import. Is that right?
            </Text>
            <TextInput
              placeholder="Actual balance, if different"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              keyboardAppearance="dark"
              onChangeText={(v) => setImportState((prev) => ({ ...prev, reconcileDrafts: { ...prev.reconcileDrafts, [card.account]: v } }))}
              style={{ backgroundColor: colors.surface, borderRadius: radius.sm, color: colors.text, padding: 8, marginBottom: 8 }}
            />
            <ActionButton label="That's correct" onPress={() => onDismissReconciliation(card.account)} />
            <ActionButton label="Correct it" onPress={() => onCorrectBalance(card.account)} />
          </View>
        ))}

        {importState.flaggedRows.map((row) => (
          <View key={row.id} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text, fontSize: 12, marginBottom: 4 }}>{row.reason}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 8 }}>
              {row.raw['Period']} · {row.raw['Accounts']} · {row.raw['Category']}
              {row.raw['Subcategory'] ? ` > ${row.raw['Subcategory']}` : ''} · {row.raw['Amount']}
            </Text>
            <TextInput
              placeholder="Correct account name"
              placeholderTextColor={colors.textMuted}
              keyboardAppearance="dark"
              onChangeText={(v) => setImportState((prev) => ({ ...prev, resolveDrafts: { ...prev.resolveDrafts, [row.id]: { ...prev.resolveDrafts[row.id], accountName: v, category: prev.resolveDrafts[row.id]?.category ?? '' } } }))}
              style={{ backgroundColor: colors.surface, borderRadius: radius.sm, color: colors.text, padding: 8, marginBottom: 6 }}
            />
            <TextInput
              placeholder="Correct category (e.g. Food/Drinks > Snacks)"
              placeholderTextColor={colors.textMuted}
              keyboardAppearance="dark"
              onChangeText={(v) => setImportState((prev) => ({ ...prev, resolveDrafts: { ...prev.resolveDrafts, [row.id]: { ...prev.resolveDrafts[row.id], category: v, accountName: prev.resolveDrafts[row.id]?.accountName ?? '' } } }))}
              style={{ backgroundColor: colors.surface, borderRadius: radius.sm, color: colors.text, padding: 8, marginBottom: 8 }}
            />
            <ActionButton label="Retry this row" onPress={() => onResolveRow(row.id, row.raw)} />
          </View>
        ))}

        <SectionTitle>Account</SectionTitle>
        <ActionButton label="Log out" onPress={handleLogout} />

        {deleteDataStep === 'idle' && <ActionButton label="Delete my data" tone="danger" onPress={() => setDeleteDataStep('confirming')} />}
        {deleteDataStep === 'confirming' && (
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text, marginBottom: spacing.sm }}>
              This deletes all your transactions, accounts, categories, and budgets — but keeps your login and chat history. This cannot be undone.
            </Text>
            <ActionButton label="Yes, delete my data" tone="danger" onPress={handleDeleteMyData} />
            <ActionButton label="Cancel" onPress={() => setDeleteDataStep('idle')} />
          </View>
        )}
        {deleteDataStep === 'deleting' && <ActivityIndicator color={colors.primary} />}

        {deleteStep === 'idle' && <ActionButton label="Delete my account" tone="danger" onPress={() => setDeleteStep('confirming')} />}
        {deleteStep === 'confirming' && (
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text, marginBottom: spacing.sm }}>
              This permanently deletes your account and all your data. This cannot be undone.
            </Text>
            <ActionButton label="Yes, delete everything" tone="danger" onPress={handleDeleteAccount} />
            <ActionButton label="Cancel" onPress={() => setDeleteStep('idle')} />
          </View>
        )}
        {deleteStep === 'deleting' && <ActivityIndicator color={colors.primary} />}
      </ScrollView>
    </View>
  );
}
