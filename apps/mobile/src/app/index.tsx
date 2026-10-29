import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { colors, spacing } from '@/theme/tokens';

/** M0 home (wireframe 01 flavour). The voice-first start screen arrives in M1/M2. */
export default function HomeScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.hero}>
        <AppText variant="largeTitle" accessibilityRole="header" style={styles.center}>
          HeyNavi
        </AppText>
        <AppText variant="headline" tone="secondary" style={styles.center}>
          See more. Go further.
        </AppText>
      </View>
      <View style={styles.actions}>
        <Button
          large
          label="Open device diagnostics"
          accessibilityHint="Opens camera, speech and backend tests for this iPhone."
          onPress={() => router.push('/diagnostics')}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.xl,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.md,
  },
  center: {
    textAlign: 'center',
  },
  actions: {
    paddingBottom: spacing.xl,
  },
});
