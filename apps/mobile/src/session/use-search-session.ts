import { uuid } from 'expo';
import type { CameraView } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { ConceptId } from '@/agent/phrases';
import { isActive } from '@/agent/search-machine';
import type { Lang } from '@/agent/types';
import { detect } from '@/api/client';
import { playHaptic } from '@/feedback/haptics';
import { SESSION_CAPTURE, captureFrame } from '@/perception/capture';
import { createSearchController, type SearchController } from '@/session/search-controller';
import { createExpoSpeaker } from '@/voice/speaker';

const KEEP_AWAKE_TAG = 'heynavi-search';

/**
 * The controller plus a callback ref for CameraView, which keeps the camera out of render.
 * `onDetach` runs when the CameraView unmounts.
 */
function createSession(onDetach: () => void): {
  controller: SearchController;
  attachCamera: (camera: CameraView | null) => void;
} {
  let camera: CameraView | null = null;
  const controller = createSearchController({
    capture: (signal) => {
      if (!camera) return Promise.reject(new Error('The camera preview is not mounted.'));
      return captureFrame(camera, signal, SESSION_CAPTURE);
    },
    detect: (request, signal) => detect(request, { signal }),
    speaker: createExpoSpeaker(),
    haptic: playHaptic,
    now: () => performance.now(),
    newGoalId: () => uuid.v4(),
    // Shows up in the Metro log; carries timings and the concept only.
    log: (line) => console.log(line),
  });
  return {
    controller,
    attachCamera: (next) => {
      camera = next;
      if (!next) onDetach();
    },
  };
}

/**
 * The live search session for the camera screen: tap to start, frames about every 0.8–1 s,
 * spoken and haptic feedback, pause in the background, full cleanup on unmount. Pass
 * `attachCamera` as the CameraView's ref and `onCameraReady` as its onCameraReady.
 * `cameraReady` is true only while a ready CameraView is attached.
 */
export function useSearchSession() {
  const [cameraReady, setCameraReady] = useState(false);
  const [{ controller, attachCamera }] = useState(() => createSession(() => setCameraReady(false)));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [concept, setConceptState] = useState<ConceptId>('chair');
  const [lang, setLangState] = useState<Lang>('en-US');
  const status = snapshot.search.status;
  const active = isActive(status);

  // Unmount: stop the loop and any speech (shutdown leaves the controller reusable).
  useEffect(() => () => controller.shutdown(), [controller]);

  // No camera in the background: pause there, and resume only what the background paused.
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

  // Release builds auto-lock the screen, which would stop the camera mid-search.
  useEffect(() => {
    if (!active) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [active]);

  function start() {
    controller.start(concept, lang);
  }

  function stop() {
    controller.stop();
  }

  function toggle() {
    if (active || status === 'PAUSED') controller.stop();
    else controller.start(concept, lang);
  }

  /** Changing the target or language mid-search starts a new goal right away. */
  function setConcept(next: ConceptId) {
    setConceptState(next);
    if (active && next !== concept) controller.start(next, lang);
  }

  function setLang(next: Lang) {
    setLangState(next);
    if (active && next !== lang) controller.start(concept, next);
  }

  function onCameraReady() {
    setCameraReady(true);
  }

  return {
    attachCamera,
    cameraReady,
    onCameraReady,
    snapshot,
    concept,
    lang,
    active,
    start,
    stop,
    toggle,
    setConcept,
    setLang,
  };
}
