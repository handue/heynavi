import { requireOptionalNativeModule } from 'expo';
import type {
  ExpoSpeechRecognitionModule as SpeechRecognitionModuleType,
  ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform } from 'react-native';

import { TTS_AUDIO_CATEGORY } from '@/diagnostics/tts-helpers';
import { CONTEXTUAL_STRINGS } from '@/voice/command-grammar';
import type { SpeechTracker } from '@/voice/speech-tracker';
import {
  createVoiceController,
  type HeardCommand,
  type RecognizerPort,
  type VoiceController,
} from '@/voice/voice-controller';
import { micStatus, voiceLabel } from '@/voice/voice-session';

/**
 * expo-speech-recognition is not part of Expo Go, where importing it throws. The native module
 * is looked up instead; without it the listener reports "Voice commands unavailable" and the
 * buttons and Magic Tap keep working.
 */
const speechModule =
  Platform.OS === 'web'
    ? null
    : requireOptionalNativeModule<typeof SpeechRecognitionModuleType>('ExpoSpeechRecognition');

/**
 * Continuous on-device English recognition. iosCategory is the very object the TTS speaker
 * applies before each utterance (tts-helpers.ts), so recognition and speech never reconfigure
 * the shared AVAudioSession against each other. The library's default mode, "measurement",
 * would lower TTS volume.
 */
export const RECOGNITION_OPTIONS: ExpoSpeechRecognitionOptions = {
  lang: 'en-US',
  continuous: true,
  interimResults: true,
  // Without an installed en-US on-device model iOS falls back to the network silently; the
  // diagnostics screen has the Airplane Mode check for that.
  requiresOnDeviceRecognition: true,
  addsPunctuation: false,
  contextualStrings: [...CONTEXTUAL_STRINGS],
  iosCategory: TTS_AUDIO_CATEGORY,
  // The heartbeat for the stall watchdog: about 3 events a second, even in silence.
  volumeChangeEventOptions: { enabled: true, intervalMillis: 300 },
};

export type VoiceCommandHandlers = {
  onCommand(heard: HeardCommand): void;
  onNotUnderstood(transcript: string): void;
  /** Listening gave up after errors (it retries on its own later). */
  onListeningLost(): void;
};

function createRecognizer(): RecognizerPort | null {
  const module = speechModule;
  if (!module) return null;
  return {
    start: () => module.start(RECOGNITION_OPTIONS),
    abort: () => module.abort(),
    requestPermissions: () => module.requestPermissionsAsync(),
  };
}

/** The controller plus a slot for the latest handlers (they close over render state). */
function createVoice(speech: SpeechTracker): {
  controller: VoiceController;
  setHandlers: (handlers: VoiceCommandHandlers) => void;
} {
  let handlers: VoiceCommandHandlers | null = null;
  const controller = createVoiceController({
    recognizer: createRecognizer(),
    speech,
    now: () => performance.now(),
    onCommand: (heard) => handlers?.onCommand(heard),
    onNotUnderstood: (transcript) => handlers?.onNotUnderstood(transcript),
    onListeningLost: () => handlers?.onListeningLost(),
    log: (line) => console.log(line),
    logTranscripts: __DEV__,
  });
  return {
    controller,
    setHandlers: (next) => {
      handlers = next;
    },
  };
}

/**
 * Always-on English voice commands for the camera screen: listening starts on mount (asking for
 * the microphone and speech permission the first time), pauses in the background, restarts on
 * every unplanned end, and stops on unmount. `speech` is the tracker around the announcer's
 * speaker, so the echo gate knows what HeyNavi is saying.
 */
export function useVoiceCommands(speech: SpeechTracker, handlers: VoiceCommandHandlers) {
  const [{ controller, setHandlers }] = useState(() => createVoice(speech));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    setHandlers(handlers);
  });

  // Subscribed before listening starts (effects run in order), removed after it stops.
  useEffect(() => {
    const module = speechModule;
    if (!module) return;
    const subscriptions = [
      module.addListener('start', () => controller.handleStart()),
      module.addListener('end', () => controller.handleEnd()),
      module.addListener('error', (event) => controller.handleError(event.error, event.message)),
      module.addListener('result', (event) =>
        controller.handleResult(event.isFinal, event.results[0]?.transcript ?? ''),
      ),
      // A segment that ended without words sends this instead of a final "result".
      module.addListener('nomatch', () => controller.handleNoMatch()),
      module.addListener('volumechange', () => controller.handleVolume()),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [controller]);

  useEffect(() => speech.subscribe(() => controller.setSpeaking(speech.speaking)), [controller, speech]);

  // 'inactive' (permission prompt, Control Center) keeps listening; only 'background' pauses.
  // Siri, a call or an alarm interrupts the audio session but leaves the app only 'inactive', so
  // every return to 'active' also retries a listener that stopped meanwhile.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        controller.setForeground(false);
      } else if (next === 'active') {
        controller.setForeground(true);
        controller.retry();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => {
    controller.enable();
    return () => controller.shutdown();
  }, [controller]);

  const status = micStatus(state);

  /** The mic button: off <-> on; after an error it retries; a permanent denial opens Settings. */
  function pressMic() {
    if (status === 'needs-permission' && !state.canAskAgain) {
      void Linking.openSettings();
    } else if (status === 'listening' || status === 'asking') {
      controller.disable();
    } else {
      controller.enable();
    }
  }

  return {
    voiceState: state,
    micStatus: status,
    micLabel: voiceLabel(state),
    pressMic,
  };
}
