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

const APP_NAME = 'Financial Assistant';
const USER_NAME = 'Alex';
const USER_INITIALS = 'A';

type Message = { id: string; role: 'user' | 'bot'; text: string; timestamp: Date };

const QUICK_ACTIONS = [
  { label: 'Log a coffee', text: 'Log a coffee purchase' },
  { label: 'Check my balance', text: "What's my balance?" },
  { label: 'Add an expense', text: 'I want to add an expense' },
];

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
};

export default function Chat({ onOpenHistory, onOpenSettings }: Props) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(20);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [voiceRepliesOn, setVoiceRepliesOn] = useState(false);
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);
  const greeting = useRef(getGreeting(USER_NAME)).current;
  const keyboardHeight = useRef(new Animated.Value(0)).current;

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

  const sendMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: Message = { id: `${Date.now()}`, role: 'user', text: trimmed, timestamp: new Date() };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setInputHeight(20);
    setIsBotThinking(true);

    setTimeout(() => {
      const botMessage: Message = {
        id: `${Date.now()}-bot`,
        role: 'bot',
        text: "This is a placeholder reply — I'm not wired up to the real brain yet.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, botMessage]);
      setIsBotThinking(false);
    }, 1200);
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
                  <Text style={{ color: isUser ? colors.background : colors.text }}>{item.text}</Text>
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
              </View>
            );
          }}
          ListFooterComponent={isBotThinking ? <ThinkingBubble /> : null}
        />
      </View>

      {/* Quick action chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        style={{ flexGrow: 0, marginBottom: 8 }}
      >
        {QUICK_ACTIONS.map((action) => (
          <Pressable
            key={action.label}
            onPress={() => sendMessage(action.text)}
            style={{
              backgroundColor: colors.surfaceAlt,
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginRight: 8,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 13 }}>{action.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Type box */}
      <View
        style={{
          backgroundColor: colors.surfaceAlt,
          borderRadius: 24,
          marginHorizontal: 16,
          marginBottom: insets.bottom + 12,
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
      </View>
    </Animated.View>
  );
}
