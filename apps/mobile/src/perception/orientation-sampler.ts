import { classifyHold, meanGravity, type Gravity, type HoldReading } from '@/perception/orientation';

/** About half a second of samples at 10 Hz. */
const WINDOW = 5;
const INTERVAL_MS = 100;

export type OrientationSampler = {
  /** How the phone is held now; null without a motion sensor (then HeyNavi stays camera-relative). */
  current(): HoldReading | null;
  stop(): void;
};

/**
 * DeviceMotion at 10 Hz into a short moving window. expo-sensors is loaded lazily: a build
 * without its native module (an older dev client) keeps working, camera-relative only.
 */
export function createOrientationSampler(): OrientationSampler {
  const samples: Gravity[] = [];
  let subscription: { remove(): void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DeviceMotion } = require('expo-sensors') as typeof import('expo-sensors');
    DeviceMotion.setUpdateInterval(INTERVAL_MS);
    subscription = DeviceMotion.addListener((measurement) => {
      const g = measurement.accelerationIncludingGravity;
      if (!g) return;
      samples.push({ x: g.x, y: g.y, z: g.z });
      if (samples.length > WINDOW) samples.shift();
    });
  } catch (e) {
    console.warn('[orientation] DeviceMotion unavailable; directions stay camera-relative', e);
  }
  return {
    current() {
      const mean = meanGravity(samples);
      return mean ? classifyHold(mean) : null;
    },
    stop() {
      subscription?.remove();
      subscription = null;
      samples.length = 0;
    },
  };
}
