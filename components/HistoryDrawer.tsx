import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors, spacing, radius } from '../theme/theme';
import { supabase } from '../lib/supabase';
import TrashIcon from './TrashIcon';

type Thread = { id: string; title: string; timestamp: string };

const SWIPE_OPEN_WIDTH = 72;
const SWIPE_TRIGGER = 40;

function ThreadRow({
  thread,
  onPress,
  onDelete,
}: {
  thread: Thread;
  onPress: () => void;
  onDelete: () => void;
}) {
  const translateX = useSharedValue(0);
  const openOffset = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      translateX.value = Math.max(0, Math.min(SWIPE_OPEN_WIDTH, openOffset.value + e.translationX));
    })
    .onEnd((e) => {
      const dragged = Math.max(0, Math.min(SWIPE_OPEN_WIDTH, openOffset.value + e.translationX));
      const isQuickFlick = e.velocityX > 400 && e.translationX > 0;
      const open = dragged > SWIPE_TRIGGER || isQuickFlick;
      openOffset.value = open ? SWIPE_OPEN_WIDTH : 0;
      translateX.value = withTiming(openOffset.value, { duration: 220, easing: Easing.out(Easing.cubic) });
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: SWIPE_OPEN_WIDTH,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Pressable
          onPress={onDelete}
          style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
        >
          <TrashIcon size={20} opacity={0.5} />
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ backgroundColor: colors.background }, rowStyle]}>
          <Pressable onPress={onPress} style={{ paddingVertical: spacing.sm }}>
            <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={2}>
              {thread.title}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2, opacity: 0.7 }}>{thread.timestamp}</Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

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

  const deleteThread = useCallback((id: string) => {
    Alert.alert('Delete conversation?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('conversations').delete().eq('id', id);
          if (error) {
            Alert.alert('Error', error.message);
            return;
          }
          setThreads((prev) => prev.filter((t) => t.id !== id));
        },
      },
    ]);
  }, []);

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
          <ThreadRow
            thread={item}
            onPress={() => onSelectConversation(item.id)}
            onDelete={() => deleteThread(item.id)}
          />
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
