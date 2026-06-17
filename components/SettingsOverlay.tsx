import { useRef } from 'react';
import { Pressable, Text, View, PanResponder } from 'react-native';
import { colors, spacing } from '../theme/theme';

const SWIPE_THRESHOLD = 60;

type Props = {
  onClose: () => void;
};

export default function SettingsOverlay({ onClose }: Props) {
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

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: 56 }}
      {...panResponder.panHandlers}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: spacing.md,
          marginBottom: spacing.md,
        }}
      >
        <Pressable
          onPress={onClose}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.text, fontSize: 18 }}>‹</Text>
        </Pressable>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginLeft: spacing.md }}>
          Settings
        </Text>
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.textMuted }}>Settings / Profile placeholder.</Text>
      </View>
    </View>
  );
}
