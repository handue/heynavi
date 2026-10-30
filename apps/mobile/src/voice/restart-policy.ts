/**
 * Auto-restart policy for continuous speech recognition, shared by the live listener
 * (voice-session.ts) and the diagnostics STT test. Pure (type imports only), so it runs under
 * `node --test`.
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
 * A session that ran at least this long and ended on silence ("no-speech", or a clean end) is
 * healthy: a quiet room must never make the listener give up.
 */
export const MIN_HEALTHY_SESSION_MS = 1000;

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

/** Restarting after these would just fail again in a tight loop. */
export const FATAL_ERRORS: readonly ExpoSpeechRecognitionErrorCode[] = [
  'not-allowed',
  'service-not-allowed',
  'language-not-supported',
];

export type RestartInput = {
  /** Auto-restarts since the last result. */
  attempt: number;
  /** Failed sessions in a row so far. */
  streak: number;
  /** First error of the session that just ended (null: it ended cleanly). */
  error: ExpoSpeechRecognitionErrorCode | null;
  hadResult: boolean;
  /** How long the session ran, start() to "end". */
  sessionMs: number;
};

export type RestartPlan =
  | { giveUp: false; delayMs: number; attempt: number; streak: number }
  | { giveUp: true; streak: number };

/**
 * What to do after an unplanned "end" of the live listener. A long session that ended on silence
 * restarts at once and is not a failure; anything else backs off and counts toward giving up.
 */
export function planRestart(input: RestartInput): RestartPlan {
  const silence = input.error == null || input.error === 'no-speech' || input.error === 'speech-timeout';
  if (input.hadResult || (silence && input.sessionMs >= MIN_HEALTHY_SESSION_MS)) {
    return { giveUp: false, delayMs: RESTART_BASE_DELAY_MS, attempt: 0, streak: 0 };
  }
  // A session that died at once (even "cleanly") is a failure: it would otherwise spin.
  const streak = nextErrorStreak(input.streak, {
    hadResult: false,
    error: input.error ?? 'unknown',
  });
  if (streak >= MAX_ERROR_STREAK) return { giveUp: true, streak };
  return {
    giveUp: false,
    delayMs: restartDelayMs(input.attempt, input.error),
    attempt: input.attempt + 1,
    streak,
  };
}
