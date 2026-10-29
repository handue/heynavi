import { requireOptionalNativeModule } from 'expo';
import { useEffect, useRef, type ComponentType } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { BackendSection } from '@/diagnostics/backend-section';
import { CameraSection } from '@/diagnostics/camera-section';
import { ReportSection } from '@/diagnostics/report-section';
import type { ReportParts, ReportPartsRef } from '@/diagnostics/report';
import { TtsSection } from '@/diagnostics/tts-section';
import { colors, spacing } from '@/theme/tokens';

type SectionProps = { reportRef: ReportPartsRef };

/**
 * expo-speech-recognition is not part of Expo Go, and importing it there throws. Load its
 * section only when the native module exists, so camera, TTS and backend tests still run in
 * Expo Go before the development build is installed.
 */
function loadSpeechRecognitionSection(): ComponentType<SectionProps> | null {
  if (requireOptionalNativeModule('ExpoSpeechRecognition') == null) return null;
  const mod = require('@/diagnostics/speech-recognition-section') as typeof import('@/diagnostics/speech-recognition-section');
  return mod.SpeechRecognitionSection;
}

const SpeechRecognitionSection = loadSpeechRecognitionSection();

/** M0 Day-0 gate tooling (G5 shutter/latency, G6 on-device STT, TTS, LAN backend). */
export default function DiagnosticsScreen() {
  const reportRef = useRef<ReportParts>({});

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      {/* Camera first: its position in the tree must stay stable (expo issue #50015). */}
      <CameraSection reportRef={reportRef} />
      {SpeechRecognitionSection ? (
        <SpeechRecognitionSection reportRef={reportRef} />
      ) : (
        <SpeechRecognitionUnavailable reportRef={reportRef} />
      )}
      <TtsSection reportRef={reportRef} />
      <BackendSection reportRef={reportRef} />
      <ReportSection reportRef={reportRef} />
    </ScrollView>
  );
}

function SpeechRecognitionUnavailable({ reportRef }: SectionProps) {
  useEffect(() => {
    reportRef.current.speechRecognition = {
      available: false,
      reason: 'ExpoSpeechRecognition native module missing (Expo Go?). Use the development build.',
    };
  }, [reportRef]);

  return (
    <Card title="Speech recognition (G6)">
      <AppText>
        Not available in this app binary. expo-speech-recognition needs the HeyNavi development
        build; Expo Go does not include it.
      </AppText>
    </Card>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
});
