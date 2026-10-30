import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { apiBaseUrl } from '@/config';
import { updateSettings } from '@/settings/app-settings';
import { cleanApiUrl } from '@/settings/settings-schema';
import { colors, spacing } from '@/theme/tokens';

/**
 * heynavi://backend?url=https://… sets the backend at runtime; ?url=default goes back to the one
 * from the build. scripts/start-tunnel.sh pushes this link to the iPhone when the Mac's tunnel
 * starts, because the tunnel URL changes every time.
 */
export default function BackendScreen() {
  const router = useRouter();
  const { url } = useLocalSearchParams<{ url?: string }>();
  const [message, setMessage] = useState('Checking the link…');

  useEffect(() => {
    if (url === 'default') {
      updateSettings({ apiUrl: null });
      setMessage(`Using the built-in server: ${apiBaseUrl()}`);
      return;
    }
    const clean = cleanApiUrl(url);
    if (!clean) {
      setMessage('That link does not hold a server address. Nothing was changed.');
      return;
    }
    updateSettings({ apiUrl: clean });
    setMessage(`Server set to ${clean}`);
  }, [url]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.body}>
        <AppText variant="title" accessibilityRole="header">
          Server
        </AppText>
        <AppText>{message}</AppText>
        <Button label="Back to the home screen" onPress={() => router.replace('/')} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  body: { flex: 1, padding: spacing.xl, gap: spacing.lg, justifyContent: 'center' },
});
