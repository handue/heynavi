import { requireOptionalNativeModule } from 'expo';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

import type { Speaker } from '@/agent/announcer';
import {
  loadVoices,
  pickVoice,
  prepareTtsAudioSession,
  type AudioSessionModule,
} from '@/diagnostics/tts-helpers';

/**
 * expo-speech-recognition owns the AVAudioSession controls (playAndRecord + defaultToSpeaker, so
 * speech plays in Silent Mode). It is not in Expo Go; there speech follows Silent Mode.
 */
const audioSessionModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<AudioSessionModule>('ExpoSpeechRecognition')
    : null;

/**
 * The announcer's Speaker on top of expo-speech. speak() queues behind anything still playing,
 * so a speak() issued right after stop() waits for that stop to finish; a stop() issued before
 * the queued speak() ran cancels it.
 */
export function createExpoSpeaker(): Speaker {
  let voices: Speech.Voice[] = [];
  void loadVoices(Speech.getAvailableVoicesAsync).then((loaded) => {
    voices = loaded;
  });
  let generation = 0;
  let stopping: Promise<void> = Promise.resolve();
  let audioSessionReported = false;

  return {
    speak(text, lang, callbacks) {
      const mine = generation;
      void stopping.then(() => {
        if (mine !== generation) {
          callbacks.onStopped();
          return;
        }
        const { audioSessionError } = prepareTtsAudioSession(audioSessionModule);
        if (audioSessionError && !audioSessionReported) {
          audioSessionReported = true;
          console.warn('[speaker] audio session setup failed', audioSessionError);
        }
        Speech.speak(text, {
          language: lang,
          voice: pickVoice(voices, lang)?.identifier,
          onStart: callbacks.onStart,
          onDone: callbacks.onDone,
          onStopped: callbacks.onStopped,
          // Never fires on iOS; the announcer's watchdog covers a lost onDone there.
          onError: callbacks.onStopped,
        });
      });
    },
    stop() {
      generation++;
      stopping = Speech.stop().catch(() => {});
    },
  };
}
