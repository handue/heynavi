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
export function createExpoSpeaker(rate: () => number = () => 1): Speaker {
  let voices: Speech.Voice[] = [];
  void loadVoices(Speech.getAvailableVoicesAsync).then((loaded) => {
    voices = loaded;
  });
  let generation = 0;
  let stopping: Promise<void> = Promise.resolve();
  let audioSessionReported = false;
  /**
   * The session had the TTS category once without an error. Nothing in the app sets another
   * category (the recognizer uses the same one), so later utterances only re-activate it.
   */
  let categoryConfirmed = false;

  return {
    speak(text, lang, callbacks) {
      const mine = generation;
      void stopping.then(() => {
        if (mine !== generation) {
          callbacks.onStopped();
          return;
        }
        const started = performance.now();
        const { audioSessionError, categoryKept, timingsMs } = prepareTtsAudioSession(audioSessionModule, {
          keepMatching: true,
          knownMatching: categoryConfirmed,
          now: () => performance.now(),
        });
        if (!audioSessionError) categoryConfirmed = true;
        const prepMs = performance.now() - started;
        // These native calls block the JS thread; a slow one delays every other JS event too.
        if (__DEV__ && prepMs >= 20) {
          console.log(
            `[speaker] audio session prep ${Math.round(prepMs)} ms (category ${categoryKept ? 'kept' : 'set'}) ${JSON.stringify(timingsMs)}`,
          );
        }
        if (audioSessionError && !audioSessionReported) {
          audioSessionReported = true;
          console.warn('[speaker] audio session setup failed', audioSessionError);
        }
        Speech.speak(text, {
          language: lang,
          rate: rate(),
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
