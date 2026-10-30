import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/theme/tokens';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.white },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.text },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.white },
        }}>
        <Stack.Screen name="index" options={{ title: 'HeyNavi', headerShown: false }} />
        {/* Not "HeyNavi": VoiceOver reads the title aloud while the app listens for "Hey Navi". */}
        <Stack.Screen name="session" options={{ title: 'Object search', headerBackTitle: 'Home' }} />
        <Stack.Screen
          name="diagnostics"
          options={{
            title: 'Device diagnostics',
            headerBackTitle: 'Home',
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </Stack>
    </>
  );
}
