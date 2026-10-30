import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ChoiceGroup } from '@/components/choice-group';
import { Field } from '@/components/field';
import type { ReportPartsRef, TtsResult } from '@/diagnostics/report';
import { voiceQualityLabel } from '@/diagnostics/tts-helpers';
import { TTS_RATES, useTtsTest, type TtsLang } from '@/diagnostics/use-tts-test';
import { formatMs } from '@/lib/stats';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = { reportRef: ReportPartsRef };

const RATE_CHOICES = TTS_RATES.map((rate) => ({
  value: rate,
  label: rate.toFixed(2).replace(/0$/, ''),
  accessibilityLabel: rate === 1 ? '1.0, system default' : String(rate),
}));

const LANG_LABEL: Record<TtsLang, string> = { 'en-US': 'English' };

const HEARD_CHOICES = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const;

function describeAudioSession(session: TtsResult['audioSession']): string {
  if (!session) return 'not set (no expo-speech-recognition module)';
  const options = session.categoryOptions.length > 0 ? session.categoryOptions.join(', ') : 'none';
  return `${session.category}, mode ${session.mode}, options ${options}`;
}

export function TtsSection({ reportRef }: Props) {
  const tts = useTtsTest();

  useEffect(() => {
    reportRef.current.tts = tts.report;
  }, [reportRef, tts.report]);

  return (
    <Card title="Text to speech" subtitle="expo-speech. speak() queues, so each test stops first.">
      {tts.controlsAudioSession ? null : (
        <View style={styles.callout} accessible>
          <AppText variant="bodyStrong">
            Turn Silent Mode off (Action button or Control Center) before testing.
          </AppText>
          <AppText tone="secondary">
            This app binary cannot set the audio session (Expo Go?), so speech is muted in Silent
            Mode.
          </AppText>
        </View>
      )}
      <ChoiceGroup label="Speech rate" choices={RATE_CHOICES} value={tts.rate} onChange={tts.setRate} />
      <View style={styles.buttons}>
        <Button label="Speak English sample" onPress={() => tts.speak('en-US')} />
        <Button label="Stop speaking" variant="danger" disabled={!tts.speaking} onPress={tts.stop} />
      </View>
      <Field label="Voices installed" value={String(tts.voices.length)} />
      {(['en-US'] as const).map((lang) => (
        <LangResult key={lang} lang={lang} tts={tts} />
      ))}
    </Card>
  );
}

function LangResult({ lang, tts }: { lang: TtsLang; tts: ReturnType<typeof useTtsTest> }) {
  const voice = tts.voiceFor(lang);
  const result = tts.results[lang];
  return (
    <View style={styles.result}>
      <AppText variant="bodyStrong">{LANG_LABEL[lang]}</AppText>
      <Field
        label="Voice"
        value={voice ? `${voice.name} (${voiceQualityLabel(voice)}, ${voice.language})` : 'none found'}
        tone={voice ? 'default' : 'danger'}
      />
      {result ? (
        <>
          <Field label="speak() to onStart" value={formatMs(result.speakToStartMs)} />
          <Field label="Speaking duration" value={formatMs(result.speakingMs)} />
          <Field label="speak() to end" value={formatMs(result.totalMs)} />
          <Field label="Outcome" value={`${result.outcome} at rate ${result.rate}`} />
          <Field label="Audio session" value={describeAudioSession(result.audioSession)} />
          {result.audioSessionError ? (
            <Field label="Audio session error" value={result.audioSessionError} tone="danger" />
          ) : null}
          <AppText variant="bodyStrong">Did you hear it?</AppText>
          <ChoiceGroup
            label={`Heard the ${LANG_LABEL[lang]} sample`}
            choices={HEARD_CHOICES}
            value={result.heard}
            onChange={(heard) => tts.setHeard(lang, heard)}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: {
    gap: spacing.sm,
  },
  result: {
    gap: spacing.xs,
  },
  callout: {
    backgroundColor: colors.lightBlue,
    borderRadius: radii.chip,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
