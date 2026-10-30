/**
 * Voice session state (the always-on listener) as a pure reducer: (state, event, now) ->
 * { state, effects }, like the search machine. voice-controller.ts runs the effects against
 * expo-speech-recognition.
 *
 * Recognition should run exactly when the user wants it (mic toggle), the app is in the
 * foreground, the permission is granted, and nothing fatal happened. Every unplanned "end"
 * restarts with back-off (restart-policy.ts); a stalled session is aborted and started again.
 *
 * "end" events carry no session id, and expo-speech-recognition sends more of them than there are
 * sessions: abort() always sends "error aborted" and then one "end", even when the session had
 * already ended on its own (which sent its own "end"). So every abort() is counted, and its "end"
 * is the first one after its "aborted" error. No new session starts while an abort is unanswered,
 * so an extra "end" can never be credited to a session that is actually running.
 */
import type { ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';

import { phrases } from '../agent/phrases.ts';
import { MAX_ERROR_STREAK, nextErrorStreak, planRestart } from './restart-policy.ts';

export const VOICE = {
  /** No volume or result event for this long while listening (and not speaking): stalled. */
  stallMs: 3000,
  /** After an abort, start again even if its "end" never arrives. */
  stallFallbackMs: 1000,
  /** After an aborted session's "end", wait this long before starting: a crossing "end" lands here. */
  afterAbortMs: 150,
  /** While Siri, a call or an alarm holds the audio session: retry this often, without giving up. */
  interruptedRetryMs: 2000,
  /** After giving up (or a retryable error) while wanted in the foreground: try again this late. */
  retryAfterErrorMs: 20_000,
} as const;

export type VoiceStatus =
  | 'off'
  | 'requesting-permission'
  | 'starting'
  | 'listening'
  | 'restarting'
  | 'paused'
  | 'error';

export type VoiceErrorReason = 'permission-denied' | 'not-supported' | 'gave-up' | 'other';

export type VoiceState = {
  status: VoiceStatus;
  /** Set exactly when status is 'error'. */
  error: VoiceErrorReason | null;
  /** Why it is paused: the app went to the background, or the user turned the mic off. */
  pausedBy: 'background' | 'user' | null;
  /** The user wants HeyNavi to listen (the mic toggle). */
  wanted: boolean;
  foreground: boolean;
  permission: 'unknown' | 'granted' | 'denied';
  /** False once iOS will not show the prompt again: only Settings can grant it then. */
  canAskAgain: boolean;
  /** HeyNavi's TTS is speaking. A stall during speech is not acted on until it ends. */
  speaking: boolean;
  /** start() was called and its "end" has not arrived yet. */
  native: boolean;
  /** An abort() for the current native session is on its way (no second one is needed). */
  abortRequested: boolean;
  /** abort() calls whose "end" has not arrived yet. Nothing starts while one is pending. */
  abortsPending: number;
  /** "aborted" errors received whose "end" has not arrived yet: the next "end" is an abort's. */
  abortAcks: number;
  /**
   * Siri, a call or an alarm interrupted the audio session and no session has started since.
   * Restarts fail at once meanwhile; they are retried slowly and do not count toward giving up.
   */
  interrupted: boolean;
  /** Start again as soon as the pending "end" arrives (watchdog restart). */
  restartOnEnd: boolean;
  /** Auto-restarts since the last result (drives the back-off). */
  attempt: number;
  /** Failed sessions in a row. */
  streak: number;
  session: {
    startedAt: number | null;
    hadResult: boolean;
    /** First error of the current session. */
    error: ExpoSpeechRecognitionErrorCode | null;
  };
  /** Restarts so far (unplanned ends and stalls), for the log. */
  restarts: number;
};

export type VoiceEvent =
  /** The user turned listening on (also on screen mount). */
  | { type: 'enable' }
  /** The user turned listening off. */
  | { type: 'disable' }
  | { type: 'permission'; granted: boolean; canAskAgain: boolean }
  | { type: 'permission-failed' }
  /** The native module is missing (Expo Go). */
  | { type: 'unsupported' }
  | { type: 'native-start' }
  | { type: 'native-end' }
  | { type: 'native-error'; code: ExpoSpeechRecognitionErrorCode }
  | { type: 'result' }
  /** start() threw: no session runs and no "end" will come. */
  | { type: 'start-failed' }
  | { type: 'restart-due' }
  /** The watchdog saw no volume or result event for VOICE.stallMs. */
  | { type: 'stall' }
  | { type: 'app-state'; active: boolean }
  /** The app became active again (also after 'inactive': Siri, a call, Control Center). */
  | { type: 'retry' }
  | { type: 'tts'; speaking: boolean }
  /** Screen unmount. The session can be enabled again afterwards. */
  | { type: 'shutdown' };

export type VoiceEffect =
  | { type: 'request-permission' }
  | { type: 'start' }
  | { type: 'abort' }
  | { type: 'schedule-restart'; delayMs: number }
  | { type: 'cancel-restart' };

export type VoiceTransition = { state: VoiceState; effects: VoiceEffect[] };

export function initialVoiceState(): VoiceState {
  return {
    status: 'off',
    error: null,
    pausedBy: null,
    wanted: false,
    foreground: true,
    permission: 'unknown',
    canAskAgain: true,
    speaking: false,
    native: false,
    abortRequested: false,
    abortsPending: 0,
    abortAcks: 0,
    interrupted: false,
    restartOnEnd: false,
    attempt: 0,
    streak: 0,
    session: { startedAt: null, hadResult: false, error: null },
    restarts: 0,
  };
}

/** Recognition should be running (or about to): wanted, foreground, permitted, no error. */
export function shouldRun(state: VoiceState): boolean {
  return state.wanted && state.foreground && state.permission === 'granted' && state.error == null;
}

export type MicStatus = 'listening' | 'paused' | 'off' | 'asking' | 'needs-permission' | 'unavailable' | 'stopped';

/** What the mic indicator shows. Restarts read as "listening", so the label does not flicker. */
export function micStatus(state: VoiceState): MicStatus {
  switch (state.status) {
    case 'starting':
    case 'listening':
    case 'restarting':
      return 'listening';
    case 'requesting-permission':
      return 'asking';
    case 'paused':
      return state.pausedBy === 'background' ? 'paused' : 'off';
    case 'off':
      return 'off';
    case 'error':
      if (state.error === 'permission-denied') return 'needs-permission';
      if (state.error === 'not-supported') return 'unavailable';
      return 'stopped';
  }
}

/** The mic indicator's text, e.g. "Listening". */
export function voiceLabel(state: VoiceState): string {
  return phrases('en-US').ui.mic.status[micStatus(state)];
}

const unchanged = (state: VoiceState): VoiceTransition => ({ state, effects: [] });

/** Starts a native session now. */
function begin(state: VoiceState, now: number, effects: VoiceEffect[] = []): VoiceTransition {
  return {
    state: {
      ...state,
      status: 'starting',
      pausedBy: null,
      native: true,
      abortRequested: false,
      restartOnEnd: false,
      session: { startedAt: now, hadResult: false, error: null },
    },
    effects: [...effects, { type: 'cancel-restart' }, { type: 'start' }],
  };
}

/** Calls abort() (counted, see the top of the file) unless one is already on its way. */
function abortNow(t: VoiceTransition): VoiceTransition {
  if (t.state.abortRequested) return t;
  return {
    state: { ...t.state, abortRequested: true, abortsPending: t.state.abortsPending + 1 },
    effects: [...t.effects, { type: 'abort' }],
  };
}

/** Aborts the native session if one runs and no abort is pending. */
function stopNative(state: VoiceState, effects: VoiceEffect[]): VoiceTransition {
  const cancelled: VoiceTransition = { state, effects: [...effects, { type: 'cancel-restart' }] };
  return state.native ? abortNow(cancelled) : cancelled;
}

/** Errors that a later attempt may get past: retried by the mic button, the app, and a timer. */
function isRetryable(error: VoiceErrorReason | null): boolean {
  return error === 'gave-up' || error === 'other';
}

/** Moves to whatever wanted / foreground / permission / error call for. */
function settle(state: VoiceState, now: number): VoiceTransition {
  if (state.error != null) {
    const stopped = stopNative({ ...state, status: 'error', pausedBy: null, restartOnEnd: false }, []);
    // Nobody may notice the mic is dead (the label is not a live region): try again later.
    if (isRetryable(state.error) && state.wanted && state.foreground) {
      stopped.effects.push({ type: 'schedule-restart', delayMs: VOICE.retryAfterErrorMs });
    }
    return stopped;
  }
  if (!state.wanted || !state.foreground) {
    const status: VoiceStatus = !state.wanted && state.status === 'off' ? 'off' : 'paused';
    const pausedBy = status === 'off' ? null : !state.wanted ? 'user' : 'background';
    return stopNative({ ...state, status, pausedBy, restartOnEnd: false }, []);
  }
  if (state.permission === 'unknown') {
    if (state.status === 'requesting-permission') return unchanged(state);
    return {
      state: { ...state, status: 'requesting-permission', pausedBy: null },
      effects: [{ type: 'request-permission' }],
    };
  }
  if (state.permission === 'denied') return settle({ ...state, error: 'permission-denied' }, now);
  if (state.status === 'starting' || state.status === 'listening') return unchanged(state);
  if (state.native || state.abortsPending > 0) {
    // The aborted session is still ending: start once its "end" arrives (or after the fallback).
    if (state.status === 'restarting' && state.restartOnEnd) return unchanged(state);
    return {
      state: { ...state, status: 'restarting', pausedBy: null, restartOnEnd: true },
      effects: [{ type: 'schedule-restart', delayMs: VOICE.stallFallbackMs }],
    };
  }
  // A restart timer is already pending.
  if (state.status === 'restarting') return unchanged(state);
  return begin(state, now);
}

/** Starts the restart that waits out an interruption now, instead of at its slow timer. */
function retryInterrupted(state: VoiceState, now: number): VoiceTransition | null {
  if (state.status !== 'restarting' || !state.interrupted || state.restartOnEnd || !shouldRun(state)) {
    return null;
  }
  return state.native || state.abortsPending > 0 ? null : begin(state, now);
}

/** A user action (toggle on, coming back to the app) retries anything but a missing module. */
function clearRetryableError(state: VoiceState): VoiceState {
  if (state.error === 'not-supported') return state;
  return {
    ...state,
    error: null,
    attempt: 0,
    streak: 0,
    // Asking again is how a permission granted in Settings is noticed.
    permission: state.permission === 'denied' ? 'unknown' : state.permission,
  };
}

export function reduceVoice(state: VoiceState, event: VoiceEvent, now: number): VoiceTransition {
  switch (event.type) {
    case 'enable': {
      const next = clearRetryableError({ ...state, wanted: true });
      return retryInterrupted(next, now) ?? settle(next, now);
    }

    case 'disable':
      return settle(
        { ...state, wanted: false, error: state.error === 'not-supported' ? state.error : null },
        now,
      );

    case 'permission':
      return settle(
        { ...state, permission: event.granted ? 'granted' : 'denied', canAskAgain: event.canAskAgain },
        now,
      );

    case 'permission-failed':
      return settle({ ...state, permission: 'unknown', error: 'other' }, now);

    case 'unsupported':
      return settle({ ...state, error: 'not-supported' }, now);

    case 'native-start':
      // The audio engine runs, so an interruption is over.
      return state.native && state.status === 'starting'
        ? { state: { ...state, status: 'listening', interrupted: false }, effects: [] }
        : unchanged(state);

    case 'result': {
      // Several results a second while the user talks: keep the same object when nothing changes.
      const settled = state.attempt === 0 && state.streak === 0 && state.session.hadResult;
      if (settled && !(state.native && state.status === 'starting')) return unchanged(state);
      // Any result proves recognition works: the back-off and the error streak end.
      const next: VoiceState = {
        ...state,
        attempt: 0,
        streak: 0,
        interrupted: false,
        session: { ...state.session, hadResult: true },
      };
      if (next.native && next.status === 'starting') next.status = 'listening';
      return { state: next, effects: [] };
    }

    case 'native-error': {
      // Only our own abort() sends "aborted", and its "end" comes next: never a failure.
      if (event.code === 'aborted') return { state: { ...state, abortAcks: state.abortAcks + 1 }, effects: [] };
      const session = { ...state.session, error: state.session.error ?? event.code };
      if (event.code === 'not-allowed') {
        return settle({ ...state, session, permission: 'denied', error: 'permission-denied' }, now);
      }
      // Permanent: no en-US recognizer on this device. "service-not-allowed" is not: iOS also
      // sends it while the on-device model downloads, while the recognizer is briefly
      // unavailable, and while Dictation is off; it restarts and, if it persists, gives up and
      // is retried later like any other failure.
      if (event.code === 'language-not-supported') {
        return settle({ ...state, session, error: 'not-supported' }, now);
      }
      const interrupted = state.interrupted || event.code === 'interrupted';
      // The "end" that follows decides about the restart.
      return { state: { ...state, session, interrupted }, effects: [] };
    }

    case 'start-failed':
      return onEnd(
        { ...state, session: { ...state.session, error: state.session.error ?? 'unknown' } },
        now,
      );

    case 'native-end': {
      if (state.abortAcks > 0) {
        const acked = { ...state, abortAcks: state.abortAcks - 1 };
        // The "end" of an abort that a fallback start already gave up on: not this session's.
        if (state.abortsPending === 0) return { state: acked, effects: [] };
        return onEnd({ ...acked, abortsPending: state.abortsPending - 1 }, now);
      }
      if (state.abortsPending > 0) {
        // The session ended on its own before our abort() was answered. That abort's "end" is
        // still to come, so nothing may start yet (it would be credited to the new session).
        return { state: { ...state, native: false }, effects: [] };
      }
      return onEnd(state, now);
    }

    case 'restart-due': {
      if (state.status === 'error') {
        // The slow retry after giving up (or after a failed permission request).
        return isRetryable(state.error) && state.wanted && state.foreground
          ? settle(clearRetryableError(state), now)
          : unchanged(state);
      }
      if (state.status !== 'restarting') return unchanged(state);
      if (!shouldRun(state)) return settle(state, now);
      // Fallback: an aborted session never sent "end"; start anyway. A late "end" of that abort
      // still comes after its "aborted" error, and is then ignored.
      return begin({ ...state, native: false, abortRequested: false, abortsPending: 0 }, now);
    }

    case 'stall': {
      const running = state.status === 'starting' || state.status === 'listening';
      if (!running || !state.native || state.speaking) return unchanged(state);
      const streak = nextErrorStreak(state.streak, { hadResult: state.session.hadResult, error: 'unknown' });
      if (streak >= MAX_ERROR_STREAK) return settle({ ...state, streak, error: 'gave-up' }, now);
      const aborted = abortNow({
        state: { ...state, status: 'restarting', streak, restartOnEnd: true, restarts: state.restarts + 1 },
        effects: [],
      });
      aborted.effects.push({ type: 'schedule-restart', delayMs: VOICE.stallFallbackMs });
      return aborted;
    }

    case 'app-state': {
      if (event.active === state.foreground) return unchanged(state);
      const next = { ...state, foreground: event.active };
      return settle(event.active && next.wanted ? clearRetryableError(next) : next, now);
    }

    case 'retry': {
      // Siri, a call or an alarm leaves the app only 'inactive': coming back is the cue to retry.
      if (!state.wanted || !state.foreground) return unchanged(state);
      const interrupted = retryInterrupted(state, now);
      if (interrupted) return interrupted;
      return isRetryable(state.error) ? settle(clearRetryableError(state), now) : unchanged(state);
    }

    case 'tts':
      return event.speaking === state.speaking
        ? unchanged(state)
        : { state: { ...state, speaking: event.speaking }, effects: [] };

    case 'shutdown': {
      // abort() even when no session is known to run: a native session the reducer lost track
      // of must not keep the microphone on after the screen is gone. Harmless when idle.
      const settled = abortNow(settle({ ...state, wanted: false, error: null, interrupted: false }, now));
      return { state: { ...settled.state, status: 'off', pausedBy: null }, effects: settled.effects };
    }
  }
}

function onEnd(state: VoiceState, now: number): VoiceTransition {
  const ended: VoiceState = { ...state, native: false, abortRequested: false };
  if (state.error != null) return { state: { ...ended, status: 'error' }, effects: [] };
  if (!shouldRun(ended)) return settle({ ...ended, restartOnEnd: false }, now);
  if (state.restartOnEnd) {
    return {
      state: { ...ended, status: 'restarting', restartOnEnd: false },
      effects: [{ type: 'schedule-restart', delayMs: VOICE.afterAbortMs }],
    };
  }
  if (state.status !== 'starting' && state.status !== 'listening') return settle(ended, now);
  if (state.interrupted) {
    // Siri, a call or an alarm holds the audio session: every start fails at once until it is
    // released. Retry slowly (sooner when the app becomes active again), without giving up.
    return {
      state: { ...ended, status: 'restarting', restarts: state.restarts + 1 },
      effects: [{ type: 'schedule-restart', delayMs: VOICE.interruptedRetryMs }],
    };
  }

  const plan = planRestart({
    attempt: state.attempt,
    streak: state.streak,
    error: state.session.error,
    hadResult: state.session.hadResult,
    sessionMs: now - (state.session.startedAt ?? now),
  });
  if (plan.giveUp) {
    // abort() anyway: a session the reducer believes ended may still be recording.
    return abortNow(settle({ ...ended, error: 'gave-up', streak: plan.streak }, now));
  }
  return {
    state: {
      ...ended,
      status: 'restarting',
      attempt: plan.attempt,
      streak: plan.streak,
      restarts: state.restarts + 1,
    },
    effects: [{ type: 'schedule-restart', delayMs: plan.delayMs }],
  };
}
