import { uuid } from 'expo';
import type { CameraView } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { phrases } from '@/agent/phrases';
import { isActive } from '@/agent/search-machine';
import { detect } from '@/api/client';
import { playHaptic } from '@/feedback/haptics';
import { SESSION_CAPTURE, captureFrame } from '@/perception/capture';
import { createSearchController, type SearchController } from '@/session/search-controller';
import { planCommand, stopsSpeech } from '@/session/voice-actions';
import type { HeardCommand } from '@/voice/voice-controller';
import { createExpoSpeaker } from '@/voice/speaker';
import { createSpeechTracker, type SpeechTracker } from '@/voice/speech-tracker';
import {
  createStopLatencyMeter,
  stopLatencyLogLine,
  type StopLatencyMeter,
  type StopSource,
} from '@/voice/stop-latency';
import { useVoiceCommands } from '@/voice/use-voice-commands';

const KEEP_AWAKE_TAG = 'heynavi-search';

/**
 * The controller plus a callback ref for CameraView, which keeps the camera out of render.
 * `onDetach` runs when the CameraView unmounts. The speaker is wrapped in a tracker, so voice
 * commands (echo gate) and the stop-latency metric know what is physically being spoken.
 */
function createSession(onDetach: () => void): {
  controller: SearchController;
  speech: SpeechTracker;
  stopLatency: StopLatencyMeter;
  attachCamera: (camera: CameraView | null) => void;
} {
  let camera: CameraView | null = null;
  const now = () => performance.now();
  const speech = createSpeechTracker(createExpoSpeaker(), { now });
  const stopLatency = createStopLatencyMeter();
  speech.subscribe((event) => {
    if (event.type === 'end' && stopLatency.ended(event.id, event.at)) {
      console.log(stopLatencyLogLine(stopLatency.summary()));
    }
  });
  const controller = createSearchController({
    capture: (signal) => {
      if (!camera) return Promise.reject(new Error('The camera preview is not mounted.'));
      return captureFrame(camera, signal, SESSION_CAPTURE);
    },
    detect: (request, signal) => detect(request, { signal }),
    speaker: speech.speaker,
    haptic: playHaptic,
    now,
    newGoalId: () => uuid.v4(),
    // Shows up in the Metro log; carries timings and the concept only.
    log: (line) => console.log(line),
  });
  return {
    controller,
    speech,
    stopLatency,
    attachCamera: (next) => {
      camera = next;
      if (!next) onDetach();
    },
  };
}

/**
 * The live search session for the camera screen: start by button, Magic Tap or voice ("Find a
 * chair"), frames about every 0.8–1 s, spoken and haptic feedback, pause in the background, full
 * cleanup on unmount. Pass `attachCamera` as the CameraView's ref and `onCameraReady` as its
 * onCameraReady. `cameraAllowed` is the camera permission; `canSearch` is true only while it is
 * granted and a ready CameraView is attached.
 */
export function useSearchSession({ cameraAllowed }: { cameraAllowed: boolean }) {
  const [cameraReady, setCameraReady] = useState(false);
  const [{ controller, speech, stopLatency, attachCamera }] = useState(() =>
    createSession(() => setCameraReady(false)),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  /** A chooser concept, or a noun phrase said by voice ("blue water bottle"). */
  const [concept, setConceptState] = useState<string>('chair');
  const status = snapshot.search.status;
  const active = isActive(status);
  const canSearch = cameraAllowed && cameraReady;

  // Unmount: stop the loop and any speech (shutdown leaves the controller reusable).
  useEffect(() => () => controller.shutdown(), [controller]);

  // No camera in the background: pause there, and resume only what the background paused. A
  // pause the user asked for ("pause") is not undone by coming back.
  useEffect(() => {
    let pausedByBackground = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        pausedByBackground = controller.pause() || pausedByBackground;
      } else if (next === 'active' && pausedByBackground) {
        pausedByBackground = false;
        controller.resume();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  /**
   * t0 of a stop-latency sample: whatever is being spoken now must go silent. A stop with nothing
   * playing gives no sample, but is logged too, so a VS-1 tester sees every stop.
   */
  function markStop(source: StopSource, at: number = performance.now()) {
    const playing = speech.activeIds();
    stopLatency.requested(source, at, playing);
    if (playing.length === 0) console.log(stopLatencyLogLine(stopLatency.summary(), { silentStop: source }));
  }

  function start() {
    controller.start(concept, 'en-US');
  }

  /** Escape gesture: stop (M1 behaviour) before leaving the screen. */
  function stop() {
    controller.stop();
  }

  /** Big button and Magic Tap. Stopping also silences any reply that was playing. */
  function toggle(source: Exclude<StopSource, 'voice'> = 'button') {
    if (active || status === 'PAUSED') {
      markStop(source);
      controller.silence();
      controller.stop();
    } else {
      controller.start(concept, 'en-US');
    }
  }

  /**
   * Changing the target mid-search starts a new goal right away. A voice-paused search counts as
   * mid-search: otherwise the screen would show the new target while "resume" brought the old
   * one back.
   */
  function setConcept(next: string) {
    setConceptState(next);
    if ((active || status === 'PAUSED') && next !== concept) controller.start(next, 'en-US');
  }

  function onCameraReady() {
    setCameraReady(true);
  }

  function onVoiceCommand(heard: HeardCommand) {
    const actions = planCommand(heard.command, {
      speaking: speech.speaking,
      speakingAtStart: heard.speakingAtStart,
      status: controller.getSnapshot().search.status,
      canSearch,
    });
    if (stopsSpeech(actions)) markStop('voice', heard.at);
    const voice = phrases('en-US').voice;
    for (const action of actions) {
      switch (action.type) {
        case 'start':
          setConceptState(action.concept);
          controller.start(action.concept, 'en-US');
          break;
        case 'stop-search':
          controller.stop();
          break;
        case 'silence':
          controller.silence();
          break;
        case 'pause':
          controller.pause();
          break;
        case 'resume':
          controller.resume();
          break;
        case 'repeat':
          if (!controller.repeat()) controller.reply('nothing-to-repeat', voice.nothingToRepeat());
          break;
        case 'reply':
          controller.reply(action.key, action.text);
          break;
      }
    }
  }

  const voice = useVoiceCommands(speech, {
    onCommand: onVoiceCommand,
    onNotUnderstood: () => controller.reply('not-understood', phrases('en-US').voice.notUnderstood()),
    onListeningLost: () => controller.reply('listening-lost', phrases('en-US').voice.listeningLost()),
  });

  // Release builds auto-lock the screen after 30 s to a few minutes, and locking sends the app to
  // the background, which stops the camera and the listener. So the screen stays awake while a
  // search runs or is paused, and while listening is wanted (for "find ..." or "resume", also
  // while the listener waits to retry after errors). Development builds hide this: Expo's
  // withDevTools keeps every screen awake when NODE_ENV is not 'production', so test auto-lock
  // on a release build.
  const keepAwake = active || status === 'PAUSED' || voice.voiceState.wanted;
  useEffect(() => {
    if (!keepAwake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [keepAwake]);

  return {
    attachCamera,
    cameraReady,
    canSearch,
    onCameraReady,
    snapshot,
    concept,
    active,
    start,
    stop,
    toggle,
    setConcept,
    voice,
  };
}
