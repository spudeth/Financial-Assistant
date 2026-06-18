import { View, Text, Pressable } from 'react-native';
import { Link } from 'expo-router';

export default function Onboarding() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-lg">
      <Text className="text-text text-2xl font-bold mb-md">Financial Assistant</Text>
      <Text className="text-textMuted text-center mb-lg">
        Onboarding placeholder — voice-driven transaction tracking starts here.
      </Text>
      <Link href="/onboarding/login" asChild>
        <Pressable className="bg-primary rounded-md px-lg py-sm">
          <Text className="text-background font-semibold">Get Started</Text>
        </Pressable>
      </Link>
    </View>
  );
}
