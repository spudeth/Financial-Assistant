import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { colors, spacing, radius } from '../theme/theme';
import { supabase } from '../lib/supabase';

type Thread = { id: string; title: string; timestamp: string };

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type Props = {
  onClose: () => void;
  onOpenSettings: () => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
};

export default function HistoryDrawer({ onClose, onOpenSettings, onSelectConversation, onNewConversation }: Props) {
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('conversations')
      .select('id, title, last_message_at')
      .order('last_message_at', { ascending: false });
    setThreads(
      (data ?? []).map((c) => ({ id: c.id, title: c.title || 'Untitled conversation', timestamp: formatRelative(c.last_message_at) }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = threads.filter((t) => t.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 56 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.md,
          marginBottom: spacing.md,
        }}
      >
        <Pressable
          onPress={onOpenSettings}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 16 }}>⚙</Text>
        </Pressable>

        <Text style={{ color: colors.text, fontWeight: '600' }}>You</Text>

        <Pressable
          onPress={onClose}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 16 }}>→</Text>
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.md, marginBottom: spacing.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: 'rgba(255,255,255,0.08)',
            borderRadius: radius.full,
            paddingHorizontal: spacing.md,
            height: 40,
          }}
        >
          <Text style={{ color: colors.textMuted, marginRight: spacing.xs }}>🔍</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search threads"
            placeholderTextColor={colors.textMuted}
            keyboardAppearance="dark"
            style={{ flex: 1, color: colors.text }}
          />
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: spacing.md }}
        refreshing={loading}
        onRefresh={load}
        ListEmptyComponent={
          <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg }}>
            {loading ? 'Loading…' : query ? 'No matches.' : 'No conversations yet.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onSelectConversation(item.id)}
            style={{
              paddingVertical: spacing.sm,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2, opacity: 0.7 }}>{item.timestamp}</Text>
          </Pressable>
        )}
      />

      <Pressable
        onPress={onNewConversation}
        style={{
          position: 'absolute',
          bottom: 32,
          right: 16,
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.background, fontSize: 24, fontWeight: '600' }}>+</Text>
      </Pressable>
    </View>
  );
}
