import * as Device from 'expo-device';
import { isRunningInExpoGo } from 'expo';
import type { RefObject } from 'react';

import { apiBaseUrl, appToken } from '@/config';
import type { Summary } from '@/lib/stats';

export type YesNoAnswer = 'yes' | 'no' | 'unanswered';
export type ShutterAnswer = YesNoAnswer;

export type CameraReport = {
  pictureSize: string;
  /** getAvailablePictureSizesAsync() once the camera was ready; null if not loaded. */
  availablePictureSizes: string[] | null;
  availablePictureSizesError?: string;
  targetIntervalMs: number;
  framesCaptured: number;
  framesRequested: number;
  outcome: 'done' | 'cancelled' | 'error';
  error?: string;
  captureMs: Summary | null;
  processMs: Summary | null;
  totalMs: Summary | null;
  achievedIntervalMs: Summary | null;
  output: string | null;
  base64KB: Summary | null;
  shutterSoundHeard: ShutterAnswer;
  /**
   * Native recognizer state (getStateAsync) sampled before the first frame and after each one:
   * true if any sample was not "inactive". Null when it could not be read (Expo Go).
   */
  speechRecognitionActive: boolean | null;
};

export type SttStreakError = { clock: string; locale: string; error: string };

export type SttLocaleReport = {
  sessions: number;
  autoRestarts: number;
  inSupportedLocales: boolean | null;
  firstResultLatencyMs: number | null;
  finalSegments: string[];
  errors: string[];
};

export type SpeechRecognitionReport =
  | { available: false; reason: string }
  | {
      available: true;
      permission: string | null;
      /** SFSpeechRecognizer().supportsOnDeviceRecognition for the DEVICE DEFAULT locale only. */
      onDeviceForDefaultLocale: boolean | null;
      requiresOnDeviceRecognition: true;
      airplaneModeVerified: 'not recorded by the app; tester must confirm';
      /** First error of the latest streak of failed sessions; the 50-entry log may have dropped it. */
      firstStreakError: SttStreakError | null;
      /** Set when auto-restart gave up after this many failed sessions in a row. */
      autoRestartStoppedAfterErrors: number | null;
      locales: Partial<Record<string, SttLocaleReport>>;
    };

export type TtsResult = {
  language: string;
  voiceName: string | null;
  voiceIdentifier: string | null;
  /** "Premium" (from the identifier), else expo-speech's Default/Enhanced. */
  voiceQuality: string | null;
  rate: number;
  /** getAudioSessionCategoryAndOptionsIOS() just before speak(); null without the native module (Expo Go). */
  audioSession: { category: string; categoryOptions: string[]; mode: string } | null;
  audioSessionError: string | null;
  /** speak() call -> onStart. */
  speakToStartMs: number | null;
  /** onStart -> onDone (or onStopped). */
  speakingMs: number | null;
  /** speak() call -> onDone (or onStopped). */
  totalMs: number | null;
  outcome: 'speaking' | 'done' | 'stopped';
  /** Tester's answer to "Did you hear it?". */
  heard: YesNoAnswer;
};

export type TtsReport = {
  voicesAvailable: number;
  results: Partial<Record<string, TtsResult>>;
};

export type BackendReport = {
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  keyConfigured: boolean | null;
  version: string | null;
  error: string | null;
  at: string;
};

/** Each section writes its latest summary here; "Show report" reads it. */
export type ReportParts = {
  camera?: CameraReport;
  speechRecognition?: SpeechRecognitionReport;
  tts?: TtsReport;
  backend?: BackendReport;
};

export type ReportPartsRef = RefObject<ReportParts>;

export function buildReport(parts: ReportParts) {
  return {
    generatedAt: new Date().toISOString(),
    runtime: isRunningInExpoGo() ? 'expo-go' : 'development-or-release-build',
    device: {
      modelName: Device.modelName,
      osName: Device.osName,
      osVersion: Device.osVersion,
      isDevice: Device.isDevice,
    },
    config: {
      apiBaseUrl: apiBaseUrl(),
      appTokenConfigured: appToken.length > 0,
    },
    camera: parts.camera ?? 'not run',
    speechRecognition: parts.speechRecognition ?? 'not run',
    tts: parts.tts ?? 'not run',
    backend: parts.backend ?? 'not run',
  };
}
