import { useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { colors, spacing, radius } from '../theme/theme';

type Thread = { id: string; title: string; preview: string; timestamp: string };

const MOCK_THREADS: Thread[] = [
  {
    id: '1',
    title: 'Grocery budget check-in',
    preview: 'You spent $142 on groceries this week, about 12% under your average.',
    timestamp: 'Just now',
  },
  {
    id: '2',
    title: 'Subscription audit',
    preview: 'Found 3 subscriptions you might not be using: Hulu, Headspace, and Calm.',
    timestamp: '3h ago',
  },
  {
    id: '3',
    title: 'Savings goal progress',
    preview: 'You are 64% toward your $5,000 emergency fund goal.',
    timestamp: '2d ago',
  },
];

type Props = {
  onClose: () => void;
  onOpenSettings: () => void;
};

export default function HistoryDrawer({ onClose, onOpenSettings }: Props) {
  const [query, setQuery] = useState('');

  const filtered = MOCK_THREADS.filter(
    (t) =>
      t.title.toLowerCase().includes(query.toLowerCase()) ||
      t.preview.toLowerCase().includes(query.toLowerCase())
  );

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
        ListEmptyComponent={
          <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg }}>
            {query ? 'No matches.' : 'No conversations yet.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={onClose}
            style={{
              paddingVertical: spacing.sm,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={{ color: colors.textMuted, marginTop: 2 }} numberOfLines={2}>
              {item.preview}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2, opacity: 0.7 }}>
              {item.timestamp}
            </Text>
          </Pressable>
        )}
      />

      <Pressable
        onPress={onClose}
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
