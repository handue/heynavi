import { requireOptionalNativeModule } from 'expo';
import * as Speech from 'expo-speech';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { TtsReport, TtsResult, YesNoAnswer } from '@/diagnostics/report';
import {
  isPremiumVoice,
  loadVoices,
  prepareTtsAudioSession,
  voiceQualityLabel,
  type AudioSessionModule,
} from '@/diagnostics/tts-helpers';
import { round } from '@/lib/stats';

/**
 * expo-speech-recognition owns the AVAudioSession controls. It is not in Expo Go, so there the
 * session stays as iOS set it and speech follows Silent Mode.
 */
const audioSessionModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<AudioSessionModule>('ExpoSpeechRecognition')
    : null;

export type TtsLang = 'en-US' | 'ko-KR';

export const TTS_SAMPLES: Record<TtsLang, string> = {
  'en-US': 'Hello. This is HeyNavi. I found a chair, on the left of the camera view.',
  'ko-KR': '안녕하세요. 헤이나비입니다. 의자를 찾았어요, 화면 왼쪽에 있어요.',
};

/** 1.0 is the system default rate. */
export const TTS_RATES = [0.9, 1.0, 1.15] as const;
export type TtsRate = (typeof TTS_RATES)[number];

/**
 * Best installed voice for a language. expo-speech reports only Default/Enhanced quality, so
 * this also reads iOS voice identifiers (observed format, not a documented contract):
 * "com.apple.voice.premium.*" beats enhanced, and novelty/Eloquence voices are avoided.
 */
export function pickVoice(voices: readonly Speech.Voice[], lang: TtsLang): Speech.Voice | null {
  const prefix = lang.slice(0, 2).toLowerCase();
  const normalize = (language: string) => language.replace('_', '-').toLowerCase();
  const score = (v: Speech.Voice) =>
    (isPremiumVoice(v) ? 5 : 0) +
    (v.quality === Speech.VoiceQuality.Enhanced ? 4 : 0) +
    (normalize(v.language) === lang.toLowerCase() ? 1 : 0) -
    (/speech\.synthesis\.voice|eloquence/i.test(v.identifier) ? 10 : 0);
  const candidates = voices.filter((v) => normalize(v.language).startsWith(prefix));
  candidates.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

export function useTtsTest() {
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  const [rate, setRate] = useState<TtsRate>(1.0);
  const [results, setResults] = useState<Partial<Record<TtsLang, TtsResult>>>({});
  const [speaking, setSpeaking] = useState(false);
  // Ignores callbacks from an utterance that a newer speak() or stop() replaced.
  const tokenRef = useRef(0);

  useEffect(() => {
    void loadVoices(Speech.getAvailableVoicesAsync).then(setVoices);
    return () => {
      tokenRef.current++;
      void Speech.stop();
    };
  }, []);

  function update(lang: TtsLang, patch: Partial<TtsResult>) {
    setResults((prev) => {
      const current = prev[lang];
      return current ? { ...prev, [lang]: { ...current, ...patch } } : prev;
    });
  }

  function markInterrupted() {
    setResults((prev) => {
      const next = { ...prev };
      for (const lang of Object.keys(next) as TtsLang[]) {
        const r = next[lang];
        if (r?.outcome === 'speaking') next[lang] = { ...r, outcome: 'stopped' };
      }
      return next;
    });
  }

  async function speak(lang: TtsLang) {
    const token = ++tokenRef.current;
    markInterrupted();
    // speak() queues behind anything still playing, so clear the queue first.
    await Speech.stop();
    if (token !== tokenRef.current) return;

    const available =
      voices.length > 0 ? voices : await loadVoices(Speech.getAvailableVoicesAsync);
    // A newer speak() or stop() (or unmount) happened during the await.
    if (token !== tokenRef.current) return;
    if (voices.length === 0) setVoices(available);
    const voice = pickVoice(available, lang);
    const { audioSession, audioSessionError } = prepareTtsAudioSession(audioSessionModule);
    setResults((prev) => ({
      ...prev,
      [lang]: {
        language: lang,
        voiceName: voice?.name ?? null,
        voiceIdentifier: voice?.identifier ?? null,
        voiceQuality: voice ? voiceQualityLabel(voice) : null,
        rate,
        audioSession,
        audioSessionError,
        speakToStartMs: null,
        speakingMs: null,
        totalMs: null,
        outcome: 'speaking',
        heard: 'unanswered',
      },
    }));
    setSpeaking(true);

    const calledAt = performance.now();
    let startedAt: number | null = null;
    const finish = (outcome: 'done' | 'stopped') => {
      if (token !== tokenRef.current) return;
      const now = performance.now();
      update(lang, {
        outcome,
        speakingMs: startedAt == null ? null : round(now - startedAt),
        totalMs: round(now - calledAt),
      });
      setSpeaking(false);
    };
    Speech.speak(TTS_SAMPLES[lang], {
      language: lang,
      voice: voice?.identifier,
      rate,
      onStart: () => {
        if (token !== tokenRef.current) return;
        startedAt = performance.now();
        update(lang, { speakToStartMs: round(startedAt - calledAt) });
      },
      onDone: () => finish('done'),
      onStopped: () => finish('stopped'),
    });
  }

  async function stop() {
    tokenRef.current++;
    markInterrupted();
    setSpeaking(false);
    await Speech.stop();
  }

  function setHeard(lang: TtsLang, heard: YesNoAnswer) {
    update(lang, { heard });
  }

  const report: TtsReport = { voicesAvailable: voices.length, results };

  return {
    voices,
    voiceFor: (lang: TtsLang) => pickVoice(voices, lang),
    /** False in Expo Go: the tester must turn Silent Mode off to hear anything. */
    controlsAudioSession: audioSessionModule != null,
    rate,
    setRate,
    results,
    speaking,
    speak,
    stop,
    setHeard,
    report,
  };
}
