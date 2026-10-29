/**
 * What to do when a frame fails: how long to back off and when to say so. Pure, so it runs
 * under `node --test`. The rule is "never silent forever": a failing loop speaks again every
 * RETRY.reannounceMs for as long as it keeps failing.
 */
import type { ErrorKind } from '../agent/phrases.ts';
import type { ApiError } from '../api/detect-response.ts';

export const RETRY = {
  baseDelayMs: 1000,
  maxDelayMs: 5000,
  /** Failures in a row before the first spoken message (except the kinds below). */
  announceAfter: 2,
  reannounceMs: 20_000,
  /** A longer server Retry-After is cut to this, so a failing loop is still spoken about on time. */
  maxRetryAfterMs: 20_000,
} as const;

/** These are worth saying after the first failure: each one already took seconds, or will not fix itself. */
const SAY_AT_ONCE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'slow',
  'unauthorized',
  'notConfigured',
  'cantAnalyze',
]);

export type FailureState = {
  /** Failures in a row. */
  count: number;
  /** When the current streak was last spoken; null if it has not been. */
  announcedAt: number | null;
};

export const NO_FAILURES: FailureState = { count: 0, announcedAt: null };

/** Delay before the next attempt after `failures` failures in a row: 1 s, 2 s, 4 s, then 5 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** Math.max(0, failures - 1));
}

/** The back-off, or the server's Retry-After (429/503) when that is longer, capped. */
export function withRetryAfter(backoffMs: number, retryAfterMs: number | null): number {
  if (retryAfterMs == null || !(retryAfterMs > 0)) return backoffMs;
  return Math.max(backoffMs, Math.min(retryAfterMs, RETRY.maxRetryAfterMs));
}

export function recordFailure(
  state: FailureState,
  kind: ErrorKind,
  now: number,
): { state: FailureState; announce: boolean } {
  const count = state.count + 1;
  const announce =
    state.announcedAt == null
      ? count >= RETRY.announceAfter || SAY_AT_ONCE.has(kind)
      : now - state.announcedAt >= RETRY.reannounceMs;
  return { state: { count, announcedAt: announce ? now : state.announcedAt }, announce };
}

/** After a success: `reconnected` when the failure streak had been spoken. */
export function recordSuccess(state: FailureState): { state: FailureState; reconnected: boolean } {
  return { state: NO_FAILURES, reconnected: state.announcedAt != null };
}

/** Maps a client error to the sentence kind the user hears. */
export function errorKindFor(error: ApiError): ErrorKind {
  switch (error.kind) {
    case 'network':
    case 'aborted':
      return 'network';
    case 'timeout':
      return 'slow';
    case 'bad_response':
      return 'server';
    case 'http':
      switch (error.code) {
        case 'unauthorized':
          return 'unauthorized';
        case 'key_not_configured':
          return 'notConfigured';
        case 'content_policy_violation':
          return 'cantAnalyze';
        case 'timeout':
          return 'slow';
        default:
          return 'server';
      }
  }
}
