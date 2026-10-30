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
        {/* The session draws its own top bar over the camera (wireframe 02). */}
        <Stack.Screen name="session" options={{ title: 'Camera', headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen
          name="settings"
          options={{ title: 'Settings', headerBackTitle: 'Back', headerStyle: { backgroundColor: colors.canvas }, contentStyle: { backgroundColor: colors.canvas } }}
        />
        <Stack.Screen name="backend" options={{ title: 'Server', headerBackTitle: 'Home' }} />
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
