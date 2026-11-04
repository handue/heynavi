import { UNKNOWN_TURN, turnSince, type Quaternion } from './motion.ts';

/**
 * How far back the rotation history goes. Scene boxes stay up until the next reply, which on the
 * 2026-11-03 walk came 13–17 s after their frame (about 30 s after a failed look). With 10 s, a
 * box older than that lost its correction and jumped back to where it was drawn.
 */
export const TURN_HISTORY_MS = 30_000;

/**
 * A pause in the samples longer than this (the app was in the background, so none reached it)
 * starts the history over: turns during it were never measured. Longer than a JS stall.
 */
const GAP_MS = 3000;

export type TurnHistory = {
  push(at: number, attitude: Quaternion): void;
  /**
   * How the phone has turned between `at` and `attitude` (now). Null while there are no samples
   * (no gyroscope yet); UNKNOWN_TURN when `at` is older than the history, so boxes hide instead
   * of jumping back uncorrected.
   */
  since(at: number, attitude: Quaternion): Quaternion | null;
  clear(): void;
};

/** The gyroscope's integrated attitude over the last `keepMs` (performance.now() times). */
export function createTurnHistory(keepMs: number = TURN_HISTORY_MS): TurnHistory {
  const samples: { at: number; q: Quaternion }[] = [];
  /** True once old samples were dropped: before that, the history reaches back to the start. */
  let trimmed = false;
  return {
    push(at, attitude) {
      // After a gap, a frame from just before the first new sample is measured from it, as at the
      // start; without this, the first look after a long background lost its boxes.
      if (samples.length > 0 && at - samples[samples.length - 1].at > GAP_MS) {
        samples.length = 0;
        trimmed = false;
      }
      samples.push({ at, q: attitude });
      while (samples.length > 0 && samples[0].at < at - keepMs) {
        samples.shift();
        trimmed = true;
      }
    },
    since(at, attitude) {
      if (samples.length === 0) return null;
      // A frame taken just before the first sample (as the session starts) is measured from it.
      if (at < samples[0].at) return trimmed ? UNKNOWN_TURN : turnSince(samples[0].q, attitude);
      // The last sample at or before `at`.
      let i = samples.length - 1;
      while (i > 0 && samples[i].at > at) i--;
      return turnSince(samples[i].q, attitude);
    },
    clear() {
      samples.length = 0;
      trimmed = false;
    },
  };
}
