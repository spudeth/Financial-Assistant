import { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { signInWithEmail, signUpWithEmail, signInWithGoogle } from '../../lib/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit() {
    setErrorMessage('');
    setLoading(true);
    try {
      if (mode === 'signIn') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password);
      }
      router.replace('/(tabs)/chat');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setErrorMessage('');
    setLoading(true);
    try {
      await signInWithGoogle();
      router.replace('/(tabs)/chat');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View className="flex-1 bg-background items-center justify-center px-lg">
      <Text className="text-text text-2xl font-bold mb-lg">
        {mode === 'signIn' ? 'Log In' : 'Create Account'}
      </Text>

      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor="#9AA5B1"
        autoCapitalize="none"
        keyboardType="email-address"
        className="w-full bg-surface text-text border border-border rounded-md px-md py-sm mb-md"
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor="#9AA5B1"
        secureTextEntry
        className="w-full bg-surface text-text border border-border rounded-md px-md py-sm mb-lg"
      />

      {errorMessage ? (
        <Text className="text-danger text-center mb-md">{errorMessage}</Text>
      ) : null}

      <Pressable
        onPress={handleSubmit}
        disabled={loading}
        className="w-full bg-primary rounded-md px-lg py-sm items-center mb-md"
      >
        {loading ? (
          <ActivityIndicator color="#0B0F14" />
        ) : (
          <Text className="text-background font-semibold">
            {mode === 'signIn' ? 'Log In' : 'Sign Up'}
          </Text>
        )}
      </Pressable>

      <Pressable onPress={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')} className="mb-lg">
        <Text className="text-textMuted">
          {mode === 'signIn'
            ? "Don't have an account? Sign Up"
            : 'Already have an account? Log In'}
        </Text>
      </Pressable>

      <Pressable
        onPress={handleGoogleSignIn}
        disabled={loading}
        className="w-full bg-surface border border-border rounded-md px-lg py-sm items-center"
      >
        <Text className="text-text font-semibold">Continue with Google</Text>
      </Pressable>
    </View>
  );
}
