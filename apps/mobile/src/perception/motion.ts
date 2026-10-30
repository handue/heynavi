/**
 * Keeping SAM boxes on their objects while the phone turns. A box describes a frame captured a
 * few seconds earlier (Spark + SAM take ~4–5 s); if the phone has turned since, the object has
 * moved in the view. The gyroscope says how far the phone turned, and the camera's field of view
 * turns that into where the object now appears.
 *
 * Rotation only: walking toward something also makes it grow, which is not corrected (boxes still
 * dim as they age). Quaternions are [w, x, y, z] in the iOS device frame (x right, y toward the
 * top of the phone, z out of the screen); the back camera looks along -z.
 *
 * Pure functions marked as worklets: the overlay runs `shiftForRotation` on the UI thread.
 */

export type Quaternion = [number, number, number, number];

export const IDENTITY: Quaternion = [1, 0, 0, 0];

/**
 * Half the field of view as tangents, for portrait 9:16 frames from the iPhone's main camera
 * (26 mm equivalent: about 67° across the long side of a 16:9 frame, 41° across the short side).
 * Approximate; a 10% error leaves boxes 90% corrected.
 */
export const PORTRAIT_FOV = { tanHalfX: 0.374, tanHalfY: 0.666 } as const;

/** Beyond this much turning, boxes are hidden instead of moved. */
export const MAX_TURN_RAD = (30 * Math.PI) / 180;

export function multiply(a: Quaternion, b: Quaternion): Quaternion {
  'worklet';
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function conjugate(q: Quaternion): Quaternion {
  'worklet';
  return [q[0], -q[1], -q[2], -q[3]];
}

function normalize(q: Quaternion): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * The attitude after turning at `rate` (rad/s about the device's x, y, z axes) for `seconds`.
 * Attitude maps device coordinates to a fixed reference frame.
 */
export function integrate(q: Quaternion, rate: { x: number; y: number; z: number }, seconds: number): Quaternion {
  const angle = Math.hypot(rate.x, rate.y, rate.z) * seconds;
  if (angle === 0) return q;
  const s = Math.sin(angle / 2) / (angle / seconds);
  return normalize(multiply(q, [Math.cos(angle / 2), rate.x * s, rate.y * s, rate.z * s]));
}

/**
 * The turn from `then` to `now`, as the rotation that takes a direction in the earlier device
 * frame into the current one.
 */
export function turnSince(then: Quaternion, now: Quaternion): Quaternion {
  return multiply(conjugate(now), then);
}

/** How far a turn is, in radians. */
export function turnAngle(turn: Quaternion): number {
  'worklet';
  return 2 * Math.acos(Math.min(1, Math.abs(turn[0])));
}

function rotate(q: Quaternion, v: [number, number, number]): [number, number, number] {
  'worklet';
  const r = multiply(multiply(q, [0, v[0], v[1], v[2]]), conjugate(q));
  return [r[1], r[2], r[3]];
}

/**
 * Where a point of the earlier frame (u, v in 0..1, v down) appears after `turn`, as a shift in
 * the same units; `visible` is false when the phone turned too far to trust it. `fov` is passed
 * in, not defaulted: worklets do not capture constants used in default parameters.
 */
export function shiftForRotation(
  turn: Quaternion,
  u: number,
  v: number,
  fov: { tanHalfX: number; tanHalfY: number },
): { du: number; dv: number; visible: boolean } {
  'worklet';
  if (turnAngle(turn) > MAX_TURN_RAD) return { du: 0, dv: 0, visible: false };
  const x = (u - 0.5) * 2 * fov.tanHalfX;
  const y = (v - 0.5) * 2 * fov.tanHalfY;
  const d = rotate(turn, [x, -y, -1]);
  if (d[2] > -0.2) return { du: 0, dv: 0, visible: false };
  const u2 = 0.5 + d[0] / -d[2] / (2 * fov.tanHalfX);
  const v2 = 0.5 + -d[1] / -d[2] / (2 * fov.tanHalfY);
  return { du: u2 - u, dv: v2 - v, visible: true };
}
