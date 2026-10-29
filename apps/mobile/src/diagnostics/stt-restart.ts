/**
 * Auto-restart policy for the speech recognition test. Pure (type imports only), so it runs
 * under `node --test`.
 */
import type { ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';

export const RESTART_BASE_DELAY_MS = 250;
export const RESTART_MAX_DELAY_MS = 4000;
/** "busy" means the recognizer is still tearing down the last session: wait longer. */
export const BUSY_BASE_DELAY_MS = 1000;
export const BUSY_MAX_DELAY_MS = 8000;
/** Give up after this many sessions in a row that ended with an error and no result. */
export const MAX_ERROR_STREAK = 5;

/**
 * Delay before an auto-restart. `attempt` counts auto-restarts since the last result (0 for the
 * first), so the delay doubles from 250 ms up to 4 s (1 s up to 8 s after "busy").
 */
export function restartDelayMs(
  attempt: number,
  lastError: ExpoSpeechRecognitionErrorCode | null,
): number {
  const busy = lastError === 'busy';
  const base = busy ? BUSY_BASE_DELAY_MS : RESTART_BASE_DELAY_MS;
  const max = busy ? BUSY_MAX_DELAY_MS : RESTART_MAX_DELAY_MS;
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

/**
 * Error-streak length after a session ends. Only sessions that ended with an error AND produced
 * no result extend it; anything else breaks it.
 */
export function nextErrorStreak(
  streak: number,
  session: { hadResult: boolean; error: ExpoSpeechRecognitionErrorCode | null },
): number {
  return session.error != null && !session.hadResult ? streak + 1 : 0;
}

/** "aborted" after our own abort() call (Abort button or unmount) is not a recognition error. */
export function isSelfInflictedAbort(
  error: ExpoSpeechRecognitionErrorCode,
  abortRequested: boolean,
): boolean {
  return error === 'aborted' && abortRequested;
}
