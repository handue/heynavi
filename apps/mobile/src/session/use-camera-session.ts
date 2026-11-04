import { uuid } from 'expo';
import type { CameraView } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { createAnnouncer, type Announcement, type Announcer } from '@/agent/announcer';
import { phrases } from '@/agent/phrases';
import { isActive } from '@/agent/search-machine';
import { askQuestion, describeScene, detect, postMetrics } from '@/api/client';
import { playHaptic } from '@/feedback/haptics';
import { HeynaviMaps } from '../../modules/heynavi-maps';
import { createExpoLocationPort } from '@/navigation/expo-location-port';
import { createNavigationController, routeHint, type NavigationController } from '@/navigation/navigation-controller';
import { SCENE_CAPTURE, SESSION_CAPTURE, captureFrame, type CaptureOptions } from '@/perception/capture';
import { IDENTITY, UNKNOWN_TURN, turnAngle, type Quaternion } from '@/perception/motion';
import { createOrientationSampler, type OrientationSampler } from '@/perception/orientation-sampler';
import { createSceneController, type SceneController } from '@/scene/scene-controller';
import { scenePhrases } from '@/scene/scene-phrases';
import { createSearchController, type FrameCapture, type SearchController } from '@/session/search-controller';
import { createMetricsUploader, type MetricsUploader } from '@/session/metrics-uploader';
import { hasSearch, planCommand, startsSearch, stopsSpeech } from '@/session/voice-actions';
import { getSettings, subscribeSettings, updateSettings } from '@/settings/app-settings';
import { SPEECH_RATE } from '@/settings/settings-schema';
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

const KEEP_AWAKE_TAG = 'heynavi-session';

/**
 * What the caption card shows: the last spoken line and what kind of line it was. `description`
 * answers "what's around me", `answer` a question; `scene` is an automatic update and `status`
 * everything else (paused, not understood, search results).
 */
export type Caption = { text: string; kind: 'obstacle' | 'maybe' | 'description' | 'answer' | 'scene' | 'status' };

export function captionKind(announcement: Pick<Announcement, 'key' | 'text' | 'channel'>): Caption['kind'] {
  if (announcement.text.startsWith('Possible obstacle')) return 'obstacle';
  if (announcement.text.startsWith('There may be')) return 'maybe';
  if (announcement.key.startsWith('reply:describe')) return 'description';
  if (announcement.key.startsWith('reply:ask')) return 'answer';
  if (announcement.channel === 'camera') return 'scene';
  return 'status';
}

type Session = {
  controller: SearchController;
  scene: SceneController;
  announcer: Announcer;
  speech: SpeechTracker;
  stopLatency: StopLatencyMeter;
  /** A spoken reply to the user (priority 0). */
  reply(key: string, text: string): void;
  orientation: OrientationSampler;
  uploader: MetricsUploader;
  /** Walking directions from the map (M6), beside the camera. */
  nav: NavigationController;
  /** The line HeyNavi most recently started speaking, shown as a caption. */
  caption: { subscribe(listener: () => void): () => void; get(): Caption | null };
  attachCamera: (camera: CameraView | null) => void;
};

/**
 * The search and scene controllers on one camera and one announcer, plus a callback ref for
 * CameraView, which keeps the camera out of render. `onDetach` runs when the CameraView unmounts.
 * The speaker is wrapped in a tracker, so voice commands (echo gate) and the stop-latency metric
 * know what is physically being spoken.
 */
function createSession(onDetach: () => void): Session {
  let camera: CameraView | null = null;
  const now = () => performance.now();
  // Metric lines go to Metro's log and to the backend (runs without Metro still leave evidence).
  const metricsSession = uuid.v4();
  const uploader = createMetricsUploader({ post: (lines) => postMetrics(metricsSession, lines) });
  const log = (line: string) => {
    console.log(line);
    uploader.push(line);
  };
  const speech = createSpeechTracker(createExpoSpeaker(() => SPEECH_RATE[getSettings().speechSpeed]), { now });
  const stopLatency = createStopLatencyMeter();
  speech.subscribe((event) => {
    if (event.type === 'end' && stopLatency.ended(event.id, event.at)) {
      log(stopLatencyLogLine(stopLatency.summary()));
    }
  });
  // Bound below; the announcer reports speech starts to it for the frame-to-speech metric.
  let scene: SceneController | null = null;
  let lastSaid: Caption | null = null;
  const captionListeners = new Set<() => void>();
  const announcer = createAnnouncer(speech.speaker, {
    now,
    onSpeechStart: (announcement, at) => {
      scene?.speechStarted(announcement, at);
      lastSaid = { text: announcement.text, kind: captionKind(announcement) };
      for (const listener of captionListeners) listener();
    },
    onDrop: (announcement, reason) => {
      // An expired scene line stops counting as said (the next look may say it again).
      scene?.speechDropped(announcement, reason);
      if (__DEV__ && announcement.channel === 'camera') console.log(`[heynavi-scene] dropped ${announcement.key} (${reason})`);
    },
  });
  // How the phone is held decides between "ahead on your left" and "on the left of the camera view".
  const orientation = createOrientationSampler();
  const capture =
    (options: CaptureOptions) =>
    (signal: AbortSignal): Promise<FrameCapture> => {
      if (!camera) return Promise.reject(new Error('The camera preview is not mounted.'));
      return captureFrame(camera, signal, options);
    };
  const controller = createSearchController({
    capture: capture(SESSION_CAPTURE),
    detect: (request, signal) => detect(request, { signal }),
    speaker: speech.speaker,
    announcer,
    haptic: playHaptic,
    now,
    newGoalId: () => uuid.v4(),
    // Shows up in the Metro log; carries timings and the concept only.
    log,
  });
  const sceneController = createSceneController({
    capture: capture(SCENE_CAPTURE),
    scene: (request, signal) => describeScene(request, { signal }),
    ask: (request, signal) => askQuestion(request, { signal }),
    announcer,
    hold: () => orientation.current(),
    // While a route is followed, Spark weighs corners and crosswalks (no place or street is sent).
    route: () => routeHint(nav.getSnapshot()),
    now,
    newSessionId: () => uuid.v4(),
    log,
    // Summaries, labels and spoken lines describe the user's surroundings: development logs only.
    devLog: __DEV__ ? (line) => console.log(line) : undefined,
  });
  scene = sceneController;
  sceneController.setVerbosity(getSettings().verbosity);
  // Scene updates pause while a search runs (or is paused) and come back when it ends.
  controller.subscribe(() => {
    if (hasSearch(controller.getSnapshot().search.status)) sceneController.pause('search');
    else sceneController.resume('search');
  });
  // Route lines have their own channel, above the camera's own lines (priority 1); answers to
  // "where am I" and "what's next" are replies (priority 0).
  const nav = createNavigationController({
    maps: HeynaviMaps,
    location: createExpoLocationPort(),
    say: (line) =>
      announcer.announce({
        key: line.key,
        priority: line.kind === 'reply' ? 0 : 1,
        text: line.text,
        lang: 'en-US',
        ttlMs: line.ttlMs,
        dedupeMs: 0,
        goalId: null,
        channel: line.kind === 'reply' ? 'reply' : 'route',
      }),
    now,
    log,
    devLog: __DEV__ ? (line) => console.log(line) : undefined,
  });
  return {
    controller,
    nav,
    scene: sceneController,
    announcer,
    speech,
    stopLatency,
    orientation,
    uploader,
    reply: (key, text) =>
      announcer.announce({
        key: `reply:${key}`,
        priority: 0,
        text,
        lang: 'en-US',
        ttlMs: 5000,
        dedupeMs: 0,
        goalId: null,
        channel: 'reply',
      }),
    caption: {
      subscribe: (listener) => {
        captionListeners.add(listener);
        return () => {
          captionListeners.delete(listener);
        };
      },
      get: () => lastSaid,
    },
    attachCamera: (next) => {
      camera = next;
      if (!next) onDetach();
    },
  };
}

/**
 * The live camera session (ARCHITECTURE 2, 3.3): it starts observing as soon as the camera is
 * ready, so HeyNavi mentions what it notices without being asked. "What's around me" describes
 * the view now; "find a chair" or "where is the entrance" (voice only, no object picker) runs the
 * Active Object Search, during which scene updates pause. Magic Tap and tap-anywhere silence speech, end a search, or hold and restart
 * the updates. Everything pauses in the background and is cleaned up on unmount. Pass
 * `attachCamera` as the CameraView's ref and `onCameraReady` as its onCameraReady.
 */
export function useCameraSession({ cameraAllowed }: { cameraAllowed: boolean }) {
  const [cameraReady, setCameraReady] = useState(false);
  const [{ controller, nav, scene, announcer, speech, stopLatency, orientation, uploader, reply, caption, attachCamera }] = useState(() =>
    createSession(() => setCameraReady(false)),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const sceneSnapshot = useSyncExternalStore(scene.subscribe, scene.getSnapshot);
  const lastSaid = useSyncExternalStore(caption.subscribe, caption.get);
  const navSnapshot = useSyncExternalStore(nav.subscribe, nav.getSnapshot);
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => speech.subscribe(() => setSpeaking(speech.speaking)), [speech]);

  // How the phone has turned since the frame of the scene boxes was taken, 30 times a second, for
  // the overlay to keep them on their objects (UI thread; no re-render).
  const boxTurn = useSharedValue<Quaternion>(IDENTITY);
  const boxesFrameAt = sceneSnapshot.boxesFrameAt;
  useEffect(() => {
    boxTurn.value = IDENTITY;
    if (boxesFrameAt == null) return;
    if (__DEV__) {
      const turn = orientation.turnSince(boxesFrameAt);
      const age = ((performance.now() - boxesFrameAt) / 1000).toFixed(1);
      const turned = turn === UNKNOWN_TURN ? 'unknown' : turn ? `${((turnAngle(turn) * 180) / Math.PI).toFixed(1)}deg` : '-';
      console.log(`[heynavi-motion] boxes frame age=${age}s turned=${turned}`);
    }
    const timer = setInterval(() => {
      boxTurn.value = orientation.turnSince(boxesFrameAt) ?? IDENTITY;
    }, 33);
    return () => clearInterval(timer);
  }, [boxesFrameAt, boxTurn, orientation]);

  // Settings changed on the Settings screen apply to the open session.
  useEffect(() => {
    scene.setVerbosity(settings.verbosity);
  }, [scene, settings.verbosity]);
  /** The search target, from voice ("find a chair", "where is the entrance"). */
  const [concept, setConcept] = useState<string>('chair');
  const status = snapshot.search.status;
  const active = isActive(status);
  const searching = hasSearch(status);
  const canSearch = cameraAllowed && cameraReady;
  const updatesHeld = sceneSnapshot.pausedBy.includes('user');

  // Unmount: stop both loops and any speech (shutdown leaves the controllers reusable).
  useEffect(
    () => () => {
      controller.shutdown();
      scene.shutdown();
      orientation.stop();
      nav.shutdown();
      uploader.stop();
    },
    [controller, scene, orientation, uploader, nav],
  );

  // The primary experience: exploring starts by itself once the camera can deliver frames, unless
  // spoken updates are turned off in Settings (then HeyNavi answers only when asked).
  useEffect(() => {
    if (!canSearch) return;
    if (!getSettings().autoUpdates) scene.pause('user');
    scene.start();
  }, [canSearch, scene]);

  // No camera in the background: pause there, and resume only what the background paused. A
  // pause the user asked for ("pause") is not undone by coming back.
  useEffect(() => {
    let pausedByBackground = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        pausedByBackground = controller.pause() || pausedByBackground;
        scene.pause('background');
      } else if (next === 'active') {
        if (pausedByBackground) controller.resume();
        pausedByBackground = false;
        scene.resume('background');
      }
    });
    return () => subscription.remove();
  }, [controller, scene]);

  /**
   * t0 of a stop-latency sample: whatever is being spoken now must go silent. A stop with nothing
   * playing gives no sample, but is logged too, so a tester sees every stop.
   */
  function uploaderLog(line: string) {
    console.log(line);
    uploader.push(line);
  }

  function markStop(source: StopSource, at: number = performance.now()) {
    const playing = speech.activeIds();
    stopLatency.requested(source, at, playing);
    if (playing.length === 0) uploaderLog(stopLatencyLogLine(stopLatency.summary(), { silentStop: source }));
  }

  function holdUpdates(source: StopSource) {
    markStop(source);
    scene.pause('user');
    reply('updates-paused', scenePhrases.updatesPaused());
  }

  function restartUpdates() {
    scene.resume('user');
    reply('updates-resumed', scenePhrases.updatesResumed());
  }

  /** The big button: does what its label says (end the search, or hold / restart updates). */
  function pressPrimary() {
    if (searching) {
      markStop('button');
      announcer.clear();
      controller.stop();
    } else if (updatesHeld) {
      restartUpdates();
    } else if (sceneSnapshot.running) {
      holdUpdates('button');
    } else if (canSearch) {
      scene.start();
    }
  }

  /** Magic Tap and tap-anywhere: silence speech first; otherwise like the big button. */
  function tapAnywhere(source: 'button' | 'magic-tap') {
    if (speech.speaking) {
      markStop(source);
      announcer.clear();
    } else if (searching) {
      markStop(source);
      controller.stop();
    } else if (updatesHeld) {
      restartUpdates();
    } else if (scene.getSnapshot().running) {
      holdUpdates(source);
    } else if (canSearch) {
      scene.start();
    }
  }

  /** Escape gesture: end the search (M1 behaviour) before leaving the screen. */
  function stop() {
    controller.stop();
  }

  function describe() {
    if (__DEV__) console.log('[heynavi-ui] describe');
    reply('describe-ack', scenePhrases.describeAck());
    scene.describeNow();
  }

  /**
   * "Where is the entrance?": answer from the view; if it is not in view, search for it. Only a
   * "where" question starts a search: a misheard "what objects are nearby" ("… what projector
   * nearby") once started a search for a projector (M4 round 1).
   */
  function ask(question: string) {
    reply('describe-ack', scenePhrases.describeAck());
    const mayStartSearch = startsSearch(question);
    void scene.ask(question).then(({ searchFor }) => {
      if (searchFor && mayStartSearch && canSearch) {
        setConcept(searchFor);
        controller.start(searchFor, 'en-US');
      }
    });
  }

  function onCameraReady() {
    setCameraReady(true);
  }

  function onVoiceCommand(heard: HeardCommand) {
    const sceneNow = scene.getSnapshot();
    const actions = planCommand(heard.command, {
      speaking: speech.speaking,
      speakingAtStart: heard.speakingAtStart,
      status: controller.getSnapshot().search.status,
      canSearch,
      scene: { running: sceneNow.running, pausedByUser: sceneNow.pausedBy.includes('user') },
    });
    if (stopsSpeech(actions)) markStop('voice', heard.at);
    const voice = phrases('en-US').voice;
    for (const action of actions) {
      switch (action.type) {
        case 'start':
          setConcept(action.concept);
          controller.start(action.concept, 'en-US');
          break;
        case 'stop-search':
          controller.stop();
          break;
        case 'silence':
          announcer.clear();
          break;
        case 'pause':
          controller.pause();
          break;
        case 'resume':
          controller.resume();
          break;
        case 'repeat':
          if (!announcer.repeat()) reply('nothing-to-repeat', voice.nothingToRepeat());
          break;
        case 'reply':
          reply(action.key, action.text);
          break;
        case 'describe':
          describe();
          break;
        case 'pause-updates':
          scene.pause('user');
          break;
        case 'resume-updates':
          scene.resume('user');
          break;
        case 'ask':
          ask(action.question);
          break;
        case 'verbosity': {
          const changed = scene.stepVerbosity(action.delta);
          if (changed) updateSettings({ verbosity: scene.verbosity });
          reply(
            'verbosity',
            changed ? scenePhrases.verbosity(scene.verbosity) : scenePhrases.verbosityLimit(scene.verbosity),
          );
          break;
        }
        case 'navigate':
          void nav.start(action.destination);
          break;
        case 'next-step':
          nav.whatsNext();
          break;
        case 'where-am-i':
          void nav.whereAmI();
          break;
        case 'stop-navigation':
          nav.stop();
          break;
      }
    }
  }

  const voice = useVoiceCommands(speech, {
    onCommand: onVoiceCommand,
    onNotUnderstood: () => reply('not-understood', phrases('en-US').voice.notUnderstood()),
    onListeningLost: () => reply('listening-lost', phrases('en-US').voice.listeningLost()),
  });

  // Release builds auto-lock the screen after 30 s to a few minutes, and locking sends the app to
  // the background, which stops the camera and the listener. So the screen stays awake while
  // HeyNavi explores, while a search runs or is paused, and while listening is wanted.
  // Development builds hide this: Expo's withDevTools keeps every screen awake when NODE_ENV is
  // not 'production', so test auto-lock on a release build.
  const keepAwake = sceneSnapshot.running || active || status === 'PAUSED' || voice.voiceState.wanted || navSnapshot.status !== 'idle';
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
    sceneSnapshot,
    boxTurn,
    navSnapshot,
    /** The route card's "End route" button. */
    endRoute: () => nav.stop(),
    lastSaid,
    speaking,
    concept,
    active,
    searching,
    updatesHeld,
    pressPrimary,
    tapAnywhere,
    describe,
    stop,
    voice,
  };
}
