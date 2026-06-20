import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  Keyboard,
  KeyboardEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TextInputContentSizeChangeEventData,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../theme/theme';
import { supabase } from '../../lib/supabase';
import {
  acceptIntent,
  classifyAccount,
  editIntent,
  sendChatMessage,
  type PendingClassification,
  type PendingIntent,
} from '../../lib/api';
import { ClassifyAccountCard, IntentCard } from '../../components/ConfirmationCard';
import { FormattedMessage } from '../../components/FormattedMessage';

const APP_NAME = 'Financial Assistant';
const USER_NAME = 'Alex';
const USER_INITIALS = 'A';

type Message = { id: string; role: 'user' | 'bot'; text: string; timestamp: Date; retryText?: string };

const NIGHT_GREETINGS = ['Up late, {name}?', 'Late-night budgeting?', 'Money on your mind?'];
const DAY_GREETINGS = [
  '{name} returns.',
  'Back for more, {name}?',
  'What are we sorting out today?',
  'Money on your mind?',
];

function getGreeting(name: string): string {
  const now = new Date();
  const hour = now.getHours();
  const isNight = hour >= 22 || hour < 5;
  const pool = isNight ? NIGHT_GREETINGS : DAY_GREETINGS;
  const startOfYear = new Date(now.getFullYear(), 0, 0).getTime();
  const dayOfYear = Math.floor((now.getTime() - startOfYear) / 86400000);
  const template = pool[dayOfYear % pool.length];
  return template.replace('{name}', name || 'friend');
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ThinkingBubble() {
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(dot, { toValue: 1, duration: 400, delay: i * 150, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      )
    );
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, []);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        backgroundColor: colors.surfaceAlt,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 12,
      }}
    >
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: colors.textMuted,
            opacity: dot,
            marginHorizontal: 2,
          }}
        />
      ))}
    </View>
  );
}

function MicButton({ listening, onPress }: { listening: boolean; onPress: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (listening) {
      pulse.setValue(0);
      const loop = Animated.loop(
        Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.out(Easing.ease), useNativeDriver: true })
      );
      loop.start();
      return () => loop.stop();
    }
  }, [listening]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
      {listening && (
        <Animated.View
          style={{
            position: 'absolute',
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.primary,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          }}
        />
      )}
      <Pressable
        onPress={onPress}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: listening ? colors.primary : colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 14 }}>🎤</Text>
      </Pressable>
    </View>
  );
}

type Props = {
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  conversationId?: string;
  onConversationCreated?: (id: string) => void;
};

export default function Chat({ onOpenHistory, onOpenSettings, conversationId, onConversationCreated }: Props) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(20);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [voiceRepliesOn, setVoiceRepliesOn] = useState(false);
  const [listening, setListening] = useState(false);
  const [pendingIntents, setPendingIntents] = useState<{ key: string; data: PendingIntent }[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [warnedKeys, setWarnedKeys] = useState<Set<string>>(new Set());
  const [pendingClassifications, setPendingClassifications] = useState<PendingClassification[]>([]);
  const listRef = useRef<FlatList<Message>>(null);
  const greeting = useRef(getGreeting(USER_NAME)).current;
  const keyboardHeight = useRef(new Animated.Value(0)).current;
  // When the keyboard is open the container is already lifted by its full
  // height, so this margin is the gap to the keyboard's TOP edge. Shrink it to
  // ~25% of the closed gap (i.e. 75% closer) as the keyboard rises.
  const inputMarginBottom = keyboardHeight.interpolate({
    inputRange: [0, 300],
    outputRange: [insets.bottom + 12, (insets.bottom + 12) * 0.25],
    extrapolate: 'clamp',
  });
  const convoIdRef = useRef<string | undefined>(conversationId);

  useEffect(() => {
    convoIdRef.current = conversationId;
    setPendingIntents([]);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      setMessages(
        (data ?? []).map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'bot',
          text: m.content,
          timestamp: new Date(m.created_at),
        }))
      );
    })();
  }, [conversationId]);

  useEffect(() => {
    const animateToKeyboard = (e: KeyboardEvent, toValue: number) => {
      Animated.timing(keyboardHeight, {
        toValue,
        duration: e.duration || 250,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }).start();
    };

    const showSub = Keyboard.addListener('keyboardWillShow', (e) =>
      animateToKeyboard(e, e.endCoordinates.height)
    );
    const hideSub = Keyboard.addListener('keyboardWillHide', (e) => animateToKeyboard(e, 0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: Message = { id: `${Date.now()}`, role: 'user', text: trimmed, timestamp: new Date() };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setInputHeight(20);
    setIsBotThinking(true);

    try {
      const res = await sendChatMessage(trimmed, convoIdRef.current);
      if (!convoIdRef.current) {
        convoIdRef.current = res.conversationId;
        onConversationCreated?.(res.conversationId);
      }
      const botMessage: Message = { id: `${Date.now()}-bot`, role: 'bot', text: res.reply, timestamp: new Date() };
      setMessages((prev) => [...prev, botMessage]);
      const intents = res.pendingIntents ?? [];
      setPendingIntents(intents.map((data, i) => ({ key: `${Date.now()}-${i}`, data })));
      setPendingClassifications(res.pendingClassifications ?? []);
    } catch (err) {
      const errorMessage: Message = {
        id: `${Date.now()}-err`,
        role: 'bot',
        text: `Something went wrong: ${(err as Error).message}`,
        timestamp: new Date(),
        retryText: trimmed,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsBotThinking(false);
    }
  };

  const handleAcceptIntent = async (key: string) => {
    const item = pendingIntents.find((p) => p.key === key);
    if (!item) return;
    const force = warnedKeys.has(key);
    setBusyKey(key);
    try {
      const res = await acceptIntent(item.data, force);
      if (res.executed) {
        setMessages((prev) => [...prev, { id: `${Date.now()}-saved`, role: 'bot', text: 'Saved.', timestamp: new Date() }]);
        setPendingIntents((prev) => prev.filter((p) => p.key !== key));
        setWarnedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      } else {
        // Soft duplicate — keep the card; a second Accept forces it through.
        setMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-dup`, role: 'bot', text: `${res.message} Tap Accept again to add it anyway.`, timestamp: new Date() },
        ]);
        setWarnedKeys((prev) => new Set(prev).add(key));
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-saveerr`, role: 'bot', text: `Couldn't save that: ${(err as Error).message}`, timestamp: new Date() },
      ]);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRejectIntent = (key: string) => {
    setPendingIntents((prev) => prev.filter((p) => p.key !== key));
    setMessages((prev) => [...prev, { id: `${Date.now()}-rejected`, role: 'bot', text: 'Okay, discarded.', timestamp: new Date() }]);
  };

  const handleEditIntent = async (key: string, instruction: string) => {
    const item = pendingIntents.find((p) => p.key === key);
    if (!item) return;
    setBusyKey(key);
    try {
      // Mini-bot resolves the edit (typos → real accounts, etc.).
      const edited = await editIntent(item.data, instruction);
      const corrected = edited.intent;
      // Reflect the correction on the card; user still has to tap Accept to save it.
      setPendingIntents((prev) => prev.map((p) => (p.key === key ? { ...p, data: corrected } : p)));
    } catch (err) {
      // Couldn't resolve cleanly (e.g. an account it won't invent) — surface it and leave the card to fix.
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-editerr`, role: 'bot', text: `Couldn't apply that: ${(err as Error).message}`, timestamp: new Date() },
      ]);
    } finally {
      setBusyKey(null);
    }
  };

  const handleClassify = async (accountId: string, groupType: string, isLiability: boolean) => {
    try {
      await classifyAccount(accountId, groupType, isLiability);
      setPendingClassifications((prev) => prev.filter((a) => a.id !== accountId));
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-classifyerr`, role: 'bot', text: `Couldn't save that: ${(err as Error).message}`, timestamp: new Date() },
      ]);
    }
  };

  return (
    <Animated.View style={{ flex: 1, backgroundColor: colors.background, paddingBottom: keyboardHeight }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: 20,
          paddingTop: insets.top + 16,
          paddingBottom: 12,
        }}
      >
        <Pressable
          onPress={onOpenHistory}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 18 }}>☰</Text>
        </Pressable>

        <Pressable
          onPress={onOpenSettings}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.background, fontWeight: '700', fontSize: 14 }}>{USER_INITIALS}</Text>
        </Pressable>
      </View>

      {/* Message area */}
      <View style={{ flex: 1 }}>
        {messages.length === 0 && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 32,
            }}
            pointerEvents="none"
          >
            <Text
              style={{
                fontFamily: 'Georgia',
                fontSize: 42,
                letterSpacing: -0.5,
                textAlign: 'center',
                color: 'rgba(255,255,255,0.18)',
              }}
            >
              {greeting}
            </Text>
          </View>
        )}

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, flexGrow: 1, justifyContent: 'flex-end' }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => {
            const isUser = item.role === 'user';
            return (
              <View style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '80%', marginBottom: 12 }}>
                <View
                  style={{
                    backgroundColor: isUser ? colors.primary : colors.surfaceAlt,
                    borderRadius: 18,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  {isUser ? (
                    <Text style={{ color: colors.background }}>{item.text}</Text>
                  ) : (
                    <FormattedMessage text={item.text} color={colors.text} />
                  )}
                </View>
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: 10,
                    marginTop: 2,
                    opacity: 0.7,
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                  }}
                >
                  {formatTime(item.timestamp)}
                </Text>
                {item.retryText && (
                  <Pressable onPress={() => sendMessage(item.retryText!)}>
                    <Text style={{ color: '#ff4d4d', fontSize: 12, marginTop: 4, alignSelf: 'flex-start' }}>Retry</Text>
                  </Pressable>
                )}
              </View>
            );
          }}
          ListFooterComponent={isBotThinking ? <ThinkingBubble /> : null}
        />
      </View>

      {/* Pending confirmations stack — grows into its own scroll area when there are several */}
      {(pendingClassifications.length > 0 || pendingIntents.length > 0) && (
        <ScrollView style={{ maxHeight: 260, marginHorizontal: 16, marginBottom: 8 }} contentContainerStyle={{ paddingBottom: 4 }}>
          {pendingClassifications.map((account) => (
            <ClassifyAccountCard
              key={account.id}
              accountName={account.name}
              onSubmit={(groupType, isLiability) => handleClassify(account.id, groupType, isLiability)}
            />
          ))}
          {pendingIntents.map((item) => (
            <IntentCard
              key={item.key}
              intent={item.data}
              busy={busyKey === item.key}
              onAccept={() => handleAcceptIntent(item.key)}
              onReject={() => handleRejectIntent(item.key)}
              onEdit={(instruction) => handleEditIntent(item.key, instruction)}
            />
          ))}
        </ScrollView>
      )}

      {/* Type box */}
      <Animated.View
        style={{
          backgroundColor: colors.surfaceAlt,
          borderRadius: 24,
          marginHorizontal: 16,
          marginBottom: inputMarginBottom,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 8,
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          multiline
          placeholder={listening ? 'Listening…' : `Chat with ${APP_NAME}`}
          placeholderTextColor={colors.textMuted}
          keyboardAppearance="dark"
          style={{
            color: colors.text,
            fontSize: 15,
            height: Math.min(Math.max(20, inputHeight), 128),
            paddingTop: 0,
            paddingBottom: 0,
          }}
          onContentSizeChange={(e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
            setInputHeight(e.nativeEvent.contentSize.height)
          }
        />

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          <Pressable
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: 18 }}>+</Text>
          </Pressable>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              onPress={() => setVoiceRepliesOn((v) => !v)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: voiceRepliesOn ? colors.primary : colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14 }}>🔊</Text>
            </Pressable>

            <MicButton listening={listening} onPress={() => setListening((v) => !v)} />

            <Pressable
              onPress={() => sendMessage(input)}
              disabled={!input.trim()}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: colors.primary,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: input.trim() ? 1 : 0.4,
              }}
            >
              <Text style={{ color: colors.background, fontSize: 16, fontWeight: '700' }}>↑</Text>
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}
