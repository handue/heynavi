import { requireOptionalNativeModule } from 'expo';
import type { CameraView } from 'expo-camera';
import type { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { CameraReport, ShutterAnswer } from '@/diagnostics/report';
import { isRecognizerActive, mergeActivity } from '@/diagnostics/stt-activity';
import { withAbortAndTimeout } from '@/lib/async';
import { sleep } from '@/lib/sleep';
import { base64KB, round, summarize } from '@/lib/stats';
import {
  DIAGNOSTICS_CAPTURE,
  PICTURE_SIZE,
  captureFrame,
  isCaptureBusy,
} from '@/perception/capture';

export const CAPTURE = {
  frames: 10,
  targetIntervalMs: 1200,
  pictureSize: PICTURE_SIZE,
  ...DIAGNOSTICS_CAPTURE,
  /** A frame (capture + processing) that takes longer than this counts as hung. */
  frameTimeoutMs: 5000,
} as const;

export type FrameStat = {
  index: number;
  /** Capture start, relative to the start of the run. */
  startedAtMs: number;
  captureMs: number;
  processMs: number;
  totalMs: number;
  width: number;
  height: number;
  base64KB: number;
};

export type CaptureStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

type PictureSizes = { sizes: string[] } | { error: string } | null;

type SttStateModule = Pick<typeof ExpoSpeechRecognitionModule, 'getStateAsync'>;

/** Null in Expo Go, which does not include expo-speech-recognition. */
const sttModule = requireOptionalNativeModule<SttStateModule>('ExpoSpeechRecognition');

/** Serial capture benchmark. Cancel and timeouts end a run at once (see perception/capture). */
export function useCaptureTest(cameraRef: RefObject<CameraView | null>) {
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [frames, setFrames] = useState<FrameStat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shutterAnswer, setShutterAnswer] = useState<ShutterAnswer>('unanswered');
  const [pictureSizes, setPictureSizes] = useState<PictureSizes>(null);
  const [sttActive, setSttActive] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const sizesRequestedRef = useRef(false);

  // Unmount is not a user cancel: stop the loop, then never touch state or VoiceOver again.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** Call from CameraView's onCameraReady. Reads the supported picture sizes once. */
  function onCameraReady() {
    const camera = cameraRef.current;
    if (sizesRequestedRef.current || !camera) return;
    sizesRequestedRef.current = true;
    void loadPictureSizes(camera).then((result) => {
      if (mountedRef.current) setPictureSizes(result);
    });
  }

  async function run() {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setFrames([]);
    setError(null);
    setShutterAnswer('unanswered');
    setSttActive(null);
    setStatus('running');

    const result = await runCaptureLoop(
      () => cameraRef.current,
      controller.signal,
      (collected) => {
        if (mountedRef.current) setFrames(collected);
      },
    );
    // Also stops a capture still queued behind a hung one from ever starting.
    controller.abort();
    abortRef.current = null;
    if (!mountedRef.current) return;
    setError(result.error);
    setSttActive(result.speechRecognitionActive);
    setStatus(result.outcome);
    announceCompletion(result.outcome, result.frames, result.error);
  }

  function cancel() {
    abortRef.current?.abort();
  }

  const report: CameraReport | null =
    status === 'idle' || status === 'running'
      ? null
      : {
          pictureSize: CAPTURE.pictureSize,
          availablePictureSizes:
            pictureSizes && 'sizes' in pictureSizes ? pictureSizes.sizes : null,
          ...(pictureSizes && 'error' in pictureSizes
            ? { availablePictureSizesError: pictureSizes.error }
            : {}),
          targetIntervalMs: CAPTURE.targetIntervalMs,
          framesCaptured: frames.length,
          framesRequested: CAPTURE.frames,
          outcome: status,
          ...(error ? { error } : {}),
          captureMs: summarize(frames.map((f) => f.captureMs)),
          processMs: summarize(frames.map((f) => f.processMs)),
          totalMs: summarize(frames.map((f) => f.totalMs)),
          achievedIntervalMs: summarize(
            frames.slice(1).map((f, i) => f.startedAtMs - frames[i].startedAtMs),
          ),
          output: frames.length > 0 ? `${frames[0].width}x${frames[0].height}` : null,
          base64KB: summarize(frames.map((f) => f.base64KB)),
          shutterSoundHeard: shutterAnswer,
          speechRecognitionActive: sttActive,
        };

  return {
    status,
    frames,
    error,
    shutterAnswer,
    setShutterAnswer,
    onCameraReady,
    run,
    cancel,
    report,
  };
}

type LoopResult = {
  outcome: 'done' | 'cancelled' | 'error';
  frames: FrameStat[];
  error: string | null;
  speechRecognitionActive: boolean | null;
};

/** Kept outside the hook: the React Compiler does not support try/finally or throw in try. */
async function runCaptureLoop(
  getCamera: () => CameraView | null,
  signal: AbortSignal,
  onFrames: (frames: FrameStat[]) => void,
): Promise<LoopResult> {
  const frames: FrameStat[] = [];
  const runStart = performance.now();
  let sttActive = mergeActivity(null, await probeSpeechRecognition(signal));
  const finish = (outcome: LoopResult['outcome'], error: string | null = null): LoopResult => ({
    outcome,
    frames,
    error,
    speechRecognitionActive: sttActive,
  });
  try {
    for (let i = 0; i < CAPTURE.frames && !signal.aborted; i++) {
      const camera = getCamera();
      if (!camera) throw new Error('The camera preview is not mounted.');
      const queued = isCaptureBusy();
      const startedAt = performance.now();
      // Cancel ends the run at once; a hung capture fails the run instead of blocking it.
      const measured = await withAbortAndTimeout(
        measureFrame(camera, signal),
        signal,
        CAPTURE.frameTimeoutMs,
        `Frame ${i + 1} timed out after ${CAPTURE.frameTimeoutMs / 1000} s` +
          (queued ? ' (it waited for an earlier capture that never finished).' : '.'),
      );
      frames.push({ index: i + 1, startedAtMs: round(startedAt - runStart), ...measured });
      onFrames([...frames]);
      sttActive = mergeActivity(sttActive, await probeSpeechRecognition(signal));
      if (i < CAPTURE.frames - 1) {
        await sleep(CAPTURE.targetIntervalMs - (performance.now() - startedAt), signal);
      }
    }
    return finish(signal.aborted ? 'cancelled' : 'done');
  } catch (e) {
    if (signal.aborted) return finish('cancelled');
    return finish('error', errorMessage(e));
  }
}

/** One shared-pipeline capture, reduced to the stats this benchmark reports. */
async function measureFrame(
  camera: CameraView,
  signal: AbortSignal,
): Promise<Omit<FrameStat, 'index' | 'startedAtMs'>> {
  const { base64, width, height, captureMs, processMs, totalMs } = await captureFrame(
    camera,
    signal,
    DIAGNOSTICS_CAPTURE,
  );
  return { captureMs, processMs, totalMs, width, height, base64KB: base64KB(base64) };
}

/** Native recognizer state: true unless "inactive", null when unreadable. Never rejects. */
async function probeSpeechRecognition(signal: AbortSignal): Promise<boolean | null> {
  if (!sttModule) return null;
  try {
    const state = await withAbortAndTimeout(
      sttModule.getStateAsync(),
      signal,
      1000,
      'getStateAsync timed out',
    );
    return isRecognizerActive(state);
  } catch {
    return null;
  }
}

async function loadPictureSizes(camera: CameraView): Promise<PictureSizes> {
  try {
    return { sizes: await camera.getAvailablePictureSizesAsync() };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

function announceCompletion(outcome: CaptureStatus, frames: FrameStat[], error: string | null) {
  const median = summarize(frames.map((f) => f.totalMs))?.p50;
  const message =
    outcome === 'error'
      ? `Capture test failed after ${frames.length} frames.` + (error ? ` ${error}` : '')
      : `Capture test ${outcome === 'cancelled' ? 'cancelled' : 'finished'}: ${frames.length} frames` +
        (median != null ? `, median total ${median} milliseconds.` : '.') +
        (frames.length > 0 ? ' Did you hear a shutter sound?' : '');
  AccessibilityInfo.announceForAccessibility(message);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
