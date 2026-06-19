import { useRef, useState } from 'react';
import { Alert, Animated, Dimensions, Easing, Keyboard, PanResponder, Pressable, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Chat from './chat';
import HistoryDrawer from '../../components/HistoryDrawer';
import SettingsOverlay from '../../components/SettingsOverlay';
import { acceptIntent, processCsvRow, resolveCsvRow } from '../../lib/api';
import { csvToRows } from '../../lib/csv';
import { supabase } from '../../lib/supabase';

const { width } = Dimensions.get('window');
const DRAWER_WIDTH = Math.min(width * 0.88, 380);
const SWIPE_THRESHOLD = 60;

type FlaggedRow = { id: string; reason: string; raw: Record<string, string> };
type ReconciliationCard = { account: string; computedBalance: number };
type ImportState = {
  importing: boolean;
  progress: { processed: number; total: number } | null;
  importSummary: { imported: number; skipped: number; aiResolved: number } | null;
  flaggedRows: FlaggedRow[];
  resolveDrafts: Record<string, { accountName: string; category: string }>;
  reconciliation: ReconciliationCard[];
  reconcileDrafts: Record<string, string>;
};

export default function TabsLayout() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [importState, setImportState] = useState<ImportState>({
    importing: false,
    progress: null,
    importSummary: null,
    flaggedRows: [],
    resolveDrafts: {},
    reconciliation: [],
    reconcileDrafts: {},
  });

  const historyX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const settingsX = useRef(new Animated.Value(width)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const animateTo = (value: Animated.Value, toValue: number) => {
    Animated.timing(value, {
      toValue,
      duration: 300,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  };

  const openHistory = () => {
    Keyboard.dismiss();
    setHistoryOpen(true);
    animateTo(historyX, 0);
    animateTo(backdropOpacity, 1);
  };

  const closeHistory = () => {
    animateTo(historyX, -DRAWER_WIDTH);
    animateTo(backdropOpacity, 0);
    setTimeout(() => setHistoryOpen(false), 300);
  };

  const openSettings = () => {
    Keyboard.dismiss();
    setSettingsOpen(true);
    animateTo(settingsX, 0);
    animateTo(backdropOpacity, 1);
  };

  const closeSettings = () => {
    animateTo(settingsX, width);
    animateTo(backdropOpacity, 0);
    setTimeout(() => setSettingsOpen(false), 300);
  };

  const openSettingsFromHistory = () => {
    closeHistory();
    openSettings();
  };

  const selectConversation = (id: string) => {
    setActiveConversationId(id);
    closeHistory();
  };

  const startNewConversation = () => {
    setActiveConversationId(undefined);
    closeHistory();
  };

  const loadReconciliation = async (accountNames: Set<string>) => {
    if (accountNames.size === 0) return;
    const { data: accounts } = await supabase.from('accounts').select('id, name, starting_balance').in('name', Array.from(accountNames));
    const cards: ReconciliationCard[] = [];
    for (const acct of accounts ?? []) {
      const { data: postings } = await supabase.from('postings').select('delta').eq('account_id', acct.id);
      const total = (postings ?? []).reduce((s, p) => s + Number(p.delta), 0);
      cards.push({ account: acct.name, computedBalance: Number(acct.starting_balance) + total });
    }
    setImportState((prev) => ({ ...prev, reconciliation: cards }));
  };

  const handleImportCsv = async () => {
    setImportState((prev) => ({
      ...prev,
      importing: true,
      progress: null,
      importSummary: null,
      flaggedRows: [],
    }));
    const picked = await DocumentPicker.getDocumentAsync({ type: 'text/csv' });
    if (picked.canceled || !picked.assets?.[0]) {
      setImportState((prev) => ({ ...prev, importing: false }));
      return;
    }

    try {
      const text = await FileSystem.readAsStringAsync(picked.assets[0].uri, { encoding: FileSystem.EncodingType.UTF8 });
      const rows = csvToRows(text);
      setImportState((prev) => ({ ...prev, progress: { processed: 0, total: rows.length } }));

      let imported = 0;
      let skipped = 0;
      let aiResolved = 0;
      const flags: FlaggedRow[] = [];
      const touchedAccounts = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const res = await processCsvRow(row);
          if (res.result === 'imported' || res.result === 'ai-resolved') {
            if (res.result === 'ai-resolved') aiResolved++;
            else imported++;
            if (row['Accounts']?.trim()) touchedAccounts.add(row['Accounts'].trim());
          } else if (res.result === 'skipped') {
            skipped++;
          } else if (res.result === 'flagged') {
            flags.push({ id: res.flagId, reason: res.reason, raw: row });
          }
        } catch (e) {
          flags.push({ id: '', reason: (e as Error).message, raw: row });
        }
        setImportState((prev) => ({ ...prev, progress: { processed: i + 1, total: rows.length } }));
      }

      await loadReconciliation(touchedAccounts);
      setImportState((prev) => ({ ...prev, importSummary: { imported, skipped, aiResolved }, flaggedRows: flags }));
      Alert.alert('Import complete', `${imported} imported${aiResolved ? ` (${aiResolved} via AI)` : ''}, ${flags.length} flagged${skipped ? `, ${skipped} skipped` : ''}.`);
    } catch (e) {
      Alert.alert('Import failed', (e as Error).message);
    } finally {
      setImportState((prev) => ({ ...prev, importing: false, progress: null }));
    }
  };

  const handleResolveRow = async (flagId: string, raw: Record<string, string>) => {
    const draft = importState.resolveDrafts[flagId] ?? { accountName: '', category: '' };
    const overrides: Record<string, string> = {};
    if (draft.accountName) overrides['Accounts'] = draft.accountName;
    if (draft.category) {
      const [parent, child] = draft.category.split('>').map((s) => s.trim());
      overrides['Category'] = parent;
      if (child) overrides['Subcategory'] = child;
    }
    try {
      const res = await resolveCsvRow(flagId, raw, overrides);
      if (res.result === 'still-flagged') {
        Alert.alert('Still not resolved', res.reason);
        return;
      }
      setImportState((prev) => ({ ...prev, flaggedRows: prev.flaggedRows.filter((r) => r.id !== flagId) }));
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    }
  };

  const handleDismissReconciliation = (account: string) => {
    setImportState((prev) => ({ ...prev, reconciliation: prev.reconciliation.filter((r) => r.account !== account) }));
  };

  const handleCorrectBalance = async (account: string) => {
    const draft = importState.reconcileDrafts[account];
    const target = Number(draft);
    if (!draft || Number.isNaN(target)) {
      Alert.alert('Enter a number', 'Type the actual balance for this account.');
      return;
    }
    try {
      await acceptIntent({ intent: 'adjust_balance', account, target_balance: target, treat_as: 'adjustment' });
      setImportState((prev) => ({ ...prev, reconciliation: prev.reconciliation.filter((r) => r.account !== account) }));
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => {
        if (historyOpen || settingsOpen) return false;
        return Math.abs(gesture.dx) > 20 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > SWIPE_THRESHOLD) {
          openHistory();
        } else if (gesture.dx < -SWIPE_THRESHOLD) {
          openSettings();
        }
      },
    })
  ).current;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} {...panResponder.panHandlers}>
        <Chat
          key={activeConversationId ?? 'new'}
          conversationId={activeConversationId}
          onConversationCreated={setActiveConversationId}
          onOpenHistory={openHistory}
          onOpenSettings={openSettings}
        />
      </View>

      {(historyOpen || settingsOpen) && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            opacity: backdropOpacity,
          }}
        >
          <Pressable style={{ flex: 1 }} onPress={historyOpen ? closeHistory : closeSettings} />
        </Animated.View>
      )}

      {historyOpen && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: DRAWER_WIDTH,
            transform: [{ translateX: historyX }],
          }}
        >
          <HistoryDrawer
            onClose={closeHistory}
            onOpenSettings={openSettingsFromHistory}
            onSelectConversation={selectConversation}
            onNewConversation={startNewConversation}
          />
        </Animated.View>
      )}

      {settingsOpen && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            transform: [{ translateX: settingsX }],
          }}
        >
          <SettingsOverlay
            onClose={closeSettings}
            importState={importState}
            setImportState={setImportState}
            onImportCsv={handleImportCsv}
            onResolveRow={handleResolveRow}
            onDismissReconciliation={handleDismissReconciliation}
            onCorrectBalance={handleCorrectBalance}
          />
        </Animated.View>
      )}
    </View>
  );
}
