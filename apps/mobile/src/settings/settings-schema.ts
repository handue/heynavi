/** Settings shape and validation. Pure, so it runs under `node --test`. */
import { VERBOSITY_STEPS, type Verbosity } from '../scene/types.ts';

export type SpeechSpeed = 'slower' | 'normal' | 'faster';
export const SPEECH_SPEEDS: readonly SpeechSpeed[] = ['slower', 'normal', 'faster'];

/** expo-speech rate per setting (1.0 is the iOS default). */
export const SPEECH_RATE: Record<SpeechSpeed, number> = { slower: 0.85, normal: 1.0, faster: 1.2 };

export type AppSettings = {
  onboarded: boolean;
  speechSpeed: SpeechSpeed;
  /** Update level a new session starts with. */
  verbosity: Verbosity;
  /** Proactive scene updates when a session starts ("Auto announcements"). */
  autoUpdates: boolean;
  /** Backend base URL set at runtime (no trailing slash); null uses EXPO_PUBLIC_API_URL. */
  apiUrl: string | null;
  /** Timings and how the phone is held, drawn over the camera (Advanced; off for users). */
  devOverlay: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  speechSpeed: 'normal',
  verbosity: 'normal',
  autoUpdates: true,
  apiUrl: null,
  devOverlay: false,
};

/** An http(s) origin, optionally with a path; null when it is not one. */
export function cleanApiUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(trimmed) ? trimmed : null;
}

/** Any stored or patched value, made valid field by field. */
export function normalizeSettings(value: unknown): AppSettings {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    onboarded: v.onboarded === true,
    speechSpeed: SPEECH_SPEEDS.includes(v.speechSpeed as SpeechSpeed) ? (v.speechSpeed as SpeechSpeed) : DEFAULT_SETTINGS.speechSpeed,
    verbosity: VERBOSITY_STEPS.includes(v.verbosity as Verbosity) ? (v.verbosity as Verbosity) : DEFAULT_SETTINGS.verbosity,
    autoUpdates: v.autoUpdates !== false,
    apiUrl: cleanApiUrl(v.apiUrl),
    devOverlay: v.devOverlay === true,
  };
}
