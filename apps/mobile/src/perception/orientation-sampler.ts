import { classifyHold, meanGravity, type Gravity, type HoldReading } from '@/perception/orientation';
import { IDENTITY, integrate, turnSince, type Quaternion } from '@/perception/motion';

const INTERVAL_MS = 33;
/** About half a second of gravity samples. */
const WINDOW = 15;
/** How far back the rotation history goes: longer than a slow scene reply. */
const HISTORY_MS = 10_000;
const DEG = Math.PI / 180;

export type OrientationSampler = {
  /** How the phone is held now; null without a motion sensor (then HeyNavi stays camera-relative). */
  current(): HoldReading | null;
  /**
   * How the phone has turned since `at` (performance.now() time), for keeping boxes on their
   * objects; null without a gyroscope or history that far back.
   */
  turnSince(at: number): Quaternion | null;
  stop(): void;
};

/**
 * DeviceMotion at 30 Hz: gravity into a short moving window (how the phone is held), and the
 * gyroscope integrated into a rotation history (how it turned since a frame was taken).
 * expo-sensors is loaded lazily: a build without its native module (an older dev client) keeps
 * working, camera-relative and without box motion.
 */
export function createOrientationSampler(): OrientationSampler {
  const samples: Gravity[] = [];
  const history: { at: number; q: Quaternion }[] = [];
  let attitude: Quaternion = IDENTITY;
  let subscription: { remove(): void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DeviceMotion } = require('expo-sensors') as typeof import('expo-sensors');
    DeviceMotion.setUpdateInterval(INTERVAL_MS);
    subscription = DeviceMotion.addListener((measurement) => {
      const g = measurement.accelerationIncludingGravity;
      if (g) {
        samples.push({ x: g.x, y: g.y, z: g.z });
        if (samples.length > WINDOW) samples.shift();
      }
      // iOS reports degrees per second: gamma about x, beta about y, alpha about z.
      const r = measurement.rotationRate;
      if (r) {
        attitude = integrate(attitude, { x: r.gamma * DEG, y: r.beta * DEG, z: r.alpha * DEG }, INTERVAL_MS / 1000);
        const at = performance.now();
        history.push({ at, q: attitude });
        while (history.length > 0 && history[0].at < at - HISTORY_MS) history.shift();
      }
    });
  } catch (e) {
    console.warn('[orientation] DeviceMotion unavailable; directions stay camera-relative', e);
  }
  return {
    current() {
      const mean = meanGravity(samples);
      return mean ? classifyHold(mean) : null;
    },
    turnSince(at) {
      if (history.length === 0 || history[0].at > at) return null;
      // The last sample at or before `at`.
      let i = history.length - 1;
      while (i > 0 && history[i].at > at) i--;
      return turnSince(history[i].q, attitude);
    },
    stop() {
      subscription?.remove();
      subscription = null;
      samples.length = 0;
      history.length = 0;
    },
  };
}
