import { useRef, useState } from 'react';
import { Animated, Dimensions, Easing, PanResponder, Pressable, View } from 'react-native';
import Chat from './chat';
import HistoryDrawer from '../../components/HistoryDrawer';
import SettingsOverlay from '../../components/SettingsOverlay';

const { width } = Dimensions.get('window');
const DRAWER_WIDTH = Math.min(width * 0.88, 380);
const SWIPE_THRESHOLD = 60;

export default function TabsLayout() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <Chat onOpenHistory={openHistory} onOpenSettings={openSettings} />
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
          <HistoryDrawer onClose={closeHistory} onOpenSettings={openSettingsFromHistory} />
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
          <SettingsOverlay onClose={closeSettings} />
        </Animated.View>
      )}
    </View>
  );
}
