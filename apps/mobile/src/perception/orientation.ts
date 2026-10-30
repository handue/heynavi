/**
 * How the phone is held, from the gravity vector (ARCHITECTURE 6.3). Pure, so it runs under
 * `node --test`; orientation-sampler.ts feeds it from expo-sensors DeviceMotion.
 *
 * HeyNavi says "ahead on your left" only when the phone is upright in portrait and roughly level,
 * that is, held out in front with the camera facing the way the user faces. That is the only
 * evidence it has; it never assumes the camera points where the user is walking. Otherwise it
 * says "on the left of the camera view".
 *
 * Axes (iOS, expo-sensors accelerationIncludingGravity): x to the right of the screen, y to its
 * top, z out of the screen toward the user. Upright in portrait, gravity is about (0, -g, 0);
 * flat on its back (camera down), (0, 0, -g). The camera looks along -z.
 */
import type { HoldFrame } from '../scene/types.ts';

export const HOLD = {
  /** The camera may point this far below level (at the floor ahead) and still count as forward. */
  maxDownDeg: 55,
  /** And this far above level. */
  maxUpDeg: 25,
  /** |x| / g above this: the phone is turned sideways (landscape) or rolled too far. */
  maxSideways: 0.55,
  /** Gravity magnitudes outside this band mean the phone is being shaken: no verdict. */
  minG: 0.7,
  maxG: 1.3,
} as const;

export type Gravity = { x: number; y: number; z: number };

export type HoldReading = {
  frame: HoldFrame;
  /** Degrees the camera points below level (negative: above). */
  downDeg: number;
  /** Why it is not "forward" (for logs). */
  reason: 'forward' | 'shaking' | 'sideways' | 'not-upright' | 'too-low' | 'too-high';
};

const G = 9.80665;

/** `gravity` in m/s² (accelerationIncludingGravity, ideally averaged over a few samples). */
export function classifyHold(gravity: Gravity): HoldReading {
  const n = Math.hypot(gravity.x, gravity.y, gravity.z);
  const x = gravity.x / (n || 1);
  const y = gravity.y / (n || 1);
  const z = gravity.z / (n || 1);
  const downDeg = Math.round((Math.asin(Math.max(-1, Math.min(1, -z))) * 180) / Math.PI);
  const camera = (reason: HoldReading['reason']): HoldReading => ({ frame: 'camera', downDeg, reason });
  if (n < HOLD.minG * G || n > HOLD.maxG * G) return camera('shaking');
  if (Math.abs(x) > HOLD.maxSideways) return camera('sideways');
  // Gravity toward the bottom edge: the phone stands upright, not upside down or flat.
  if (y > -0.3) return camera('not-upright');
  if (downDeg > HOLD.maxDownDeg) return camera('too-low');
  if (downDeg < -HOLD.maxUpDeg) return camera('too-high');
  return { frame: 'forward', downDeg, reason: 'forward' };
}

/** Mean of recent samples, which takes out most of the hand's own acceleration. */
export function meanGravity(samples: readonly Gravity[]): Gravity | null {
  if (samples.length === 0) return null;
  const sum = samples.reduce((a, s) => ({ x: a.x + s.x, y: a.y + s.y, z: a.z + s.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / samples.length, y: sum.y / samples.length, z: sum.z / samples.length };
}
