import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ChoiceGroup } from '@/components/choice-group';
import { Field } from '@/components/field';
import { ToggleRow } from '@/components/toggle-row';
import type { ReportPartsRef } from '@/diagnostics/report';
import {
  useSpeechRecognitionTest,
  type SttLocale,
} from '@/diagnostics/use-speech-recognition-test';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = { reportRef: ReportPartsRef };

const LOCALES = [
  { value: 'en-US', label: 'English (en-US)', accessibilityLabel: 'English, U S' },
  { value: 'ko-KR', label: '한국어 (ko-KR)', accessibilityLabel: 'Korean' },
] as const satisfies readonly { value: SttLocale; label: string; accessibilityLabel: string }[];

function yesNo(value: boolean | null): string {
  return value == null ? 'unknown' : value ? 'yes' : 'no';
}

/** Imported only when the native module exists (not in Expo Go). */
export function SpeechRecognitionSection({ reportRef }: Props) {
  const stt = useSpeechRecognitionTest();

  useEffect(() => {
    reportRef.current.speechRecognition = stt.report;
  }, [reportRef, stt.report]);

  return (
    <Card
      title="Speech recognition (G6)"
      subtitle="Continuous, interim results, requiresOnDeviceRecognition on.">
      <View style={styles.callout} accessible>
        <AppText variant="bodyStrong">
          To prove on-device recognition, enable Airplane Mode and test both languages.
        </AppText>
        <AppText tone="secondary">
          iOS silently falls back to network recognition when a language has no on-device model,
          so only an Airplane Mode test proves it.
        </AppText>
      </View>

      <ChoiceGroup
        label="Recognition language"
        choices={LOCALES}
        value={stt.locale}
        onChange={stt.setLocale}
        disabled={stt.active}
      />

      <View style={styles.fields}>
        <Field label="Permission" value={stt.permission ?? 'not checked yet'} />
        <Field label={`${stt.locale} in getSupportedLocales()`} value={yesNo(stt.localeSupported)} />
        <Field
          label="supportsOnDeviceRecognition() (device default locale only)"
          value={yesNo(stt.onDeviceDefault)}
        />
        <Field label="isRecognitionAvailable()" value={yesNo(stt.recognitionAvailable)} />
        <Field label="State" value={stt.active ? 'listening' : 'idle'} />
      </View>

      <ToggleRow
        label="Auto-restart on end"
        value={stt.autoRestart}
        onValueChange={stt.setAutoRestart}
        accessibilityHint="Starts recognition again whenever iOS ends the session on its own."
      />
      <Field label="Auto-restarts" value={String(stt.restartCount)} />
      <Field
        label="First error of the latest error streak"
        value={
          stt.firstStreakError
            ? `${stt.firstStreakError.clock} ${stt.firstStreakError.locale} ${stt.firstStreakError.error}`
            : 'none'
        }
        tone={stt.firstStreakError ? 'danger' : 'default'}
      />
      {stt.stoppedAfterErrors != null ? (
        <AppText tone="danger">
          Auto-restart stopped after {stt.stoppedAfterErrors} failed sessions in a row. Press Start
          listening to try again.
        </AppText>
      ) : null}

      <View style={styles.buttons}>
        <Button
          label="Start listening"
          accessibilityHint="Asks for microphone and speech permission if needed, then listens."
          disabled={stt.active}
          onPress={stt.start}
        />
        <Button
          label="Stop"
          variant="secondary"
          accessibilityHint="Stops listening and keeps the final result."
          disabled={!stt.active}
          onPress={stt.stop}
        />
        <Button
          label="Abort"
          variant="danger"
          accessibilityHint="Stops listening immediately and drops the pending result."
          disabled={!stt.active}
          onPress={stt.abort}
        />
      </View>

      <View style={styles.fields}>
        <AppText variant="bodyStrong">Live (interim)</AppText>
        <AppText style={styles.interim}>{stt.interim || '…'}</AppText>
      </View>

      <View style={styles.fields}>
        <AppText variant="bodyStrong">Final segments ({stt.finals.length})</AppText>
        {stt.finals.map((f) => (
          <AppText key={f.id} selectable>
            <AppText tone="secondary">
              {f.clock} {f.locale}{' '}
            </AppText>
            {f.text}
          </AppText>
        ))}
      </View>

      <View style={styles.fields}>
        <AppText variant="bodyStrong">Event log (newest first)</AppText>
        {stt.log.map((entry) => (
          <AppText key={entry.id} variant="mono" selectable>
            {entry.clock}
            {entry.sinceStartMs == null ? '' : ` +${entry.sinceStartMs}ms`} {entry.text}
          </AppText>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  callout: {
    backgroundColor: colors.lightBlue,
    borderRadius: radii.chip,
    padding: spacing.md,
    gap: spacing.xs,
  },
  fields: {
    gap: spacing.xs,
  },
  buttons: {
    gap: spacing.sm,
  },
  interim: {
    minHeight: 48,
  },
});
