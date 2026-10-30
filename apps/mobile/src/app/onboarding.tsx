import { useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Orb } from '@/components/orb';
import { scenePhrases } from '@/scene/scene-phrases';
import { getSettings, updateSettings } from '@/settings/app-settings';
import { SPEECH_RATE } from '@/settings/settings-schema';
import { colors, spacing } from '@/theme/tokens';

type Step = 'welcome' | 'camera' | 'microphone';
const STEPS: Step[] = ['welcome', 'camera', 'microphone'];

/** Onboarding and permissions (wireframe 09). Done once; Settings can replay it. */
export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('welcome');
  const [, requestCamera] = useCameraPermissions();

  // Spoken unless VoiceOver is on: then VoiceOver reads the screen, and two voices would clash.
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isScreenReaderEnabled().then((screenReader) => {
      if (!cancelled && !screenReader) {
        Speech.speak(scenePhrases.intro(), { language: 'en-US', rate: SPEECH_RATE[getSettings().speechSpeed] });
      }
    });
    return () => {
      cancelled = true;
      void Speech.stop();
    };
  }, []);

  async function next() {
    if (step === 'welcome') {
      setStep('camera');
    } else if (step === 'camera') {
      await requestCamera().catch(() => null);
      setStep('microphone');
    } else {
      await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => null);
      void Speech.stop();
      updateSettings({ onboarded: true });
      router.replace('/session');
    }
  }

  const page = {
    welcome: {
      art: <Orb size={176} />,
      title: 'Welcome',
      text: 'HeyNavi watches the way ahead through your camera and tells you what could be in your way. Ask it questions any time. It does not replace a cane, a guide dog or mobility training.',
      button: "Let's get started",
      hint: 'Goes to the camera permission.',
    },
    camera: {
      art: <Circle icon="camera.fill" />,
      title: 'Camera access',
      text: 'HeyNavi needs the camera to look at your surroundings. Pictures are never saved.',
      button: 'Allow camera',
      hint: 'Shows the iOS camera permission prompt.',
    },
    microphone: {
      art: <Circle icon="mic.fill" />,
      title: 'Microphone access',
      text: 'HeyNavi listens for your questions and requests, and understands them on this iPhone.',
      button: 'Allow microphone',
      hint: 'Shows the iOS microphone and speech recognition prompts, then opens the camera.',
    },
  }[step];

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.body}>
        <View style={styles.art}>{page.art}</View>
        <AppText variant="largeTitle" accessibilityRole="header" style={styles.center}>
          {page.title}
        </AppText>
        <AppText tone="secondary" style={styles.center}>
          {page.text}
        </AppText>
      </View>
      <View style={styles.footer}>
        <View style={styles.dots} accessible accessibilityLabel={`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}>
          {STEPS.map((s) => (
            <View key={s} style={[styles.dot, s === step && styles.dotActive]} />
          ))}
        </View>
        <Button large label={page.button} accessibilityHint={page.hint} onPress={() => void next()} />
      </View>
    </SafeAreaView>
  );
}

function Circle({ icon }: { icon: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <View style={styles.circle}>
      <Icon name={icon} size={48} color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.xl },
  art: { marginBottom: spacing.md },
  center: { textAlign: 'center' },
  circle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.lightBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { gap: spacing.lg, paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.primary, width: 24 },
});
