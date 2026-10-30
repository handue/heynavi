/**
 * How the HeyNavi symbol moves (shader: jelly-shader.ts, component: orb.tsx). Four folded lobes
 * around a core turn slowly through a full 3D rotation while they drift, twist, stretch and
 * wobble; the whole symbol breathes and floats.
 *
 * Everything is a function of two phases that wrap at 2π: `phase`, one loop of LOOP_SECONDS at
 * speed 1, where every slow motion completes a whole number of cycles, and `pulse`, one second,
 * for the listening ripple and the speaking swell. So the animation never visibly resets, and a
 * mode change only changes how fast the phases advance and how much the shape moves: no jumps.
 *
 * Pure functions marked as worklets: they run on the UI thread each frame, and in Node for tests
 * and the preview render.
 */

/** What the symbol shows: resting, hearing the user, working on an answer, or HeyNavi speaking. */
export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Per mode: phase speed (1 = one full turn per 30 s), how much the lobes move, the ripple, and the
 * speaking swell. Listening adds the microphone level to its ripple.
 */
export type Drive = { speed: number; energy: number; ripple: number; swell: number };

export const DRIVE: Record<OrbMode, Drive> = {
  idle: { speed: 1, energy: 0.25, ripple: 0, swell: 0 },
  listening: { speed: 1.15, energy: 0.4, ripple: 0.2, swell: 0 },
  thinking: { speed: 1.4, energy: 0.65, ripple: 0, swell: 0 },
  speaking: { speed: 1.5, energy: 0.6, ripple: 0.15, swell: 1 },
};

export const LOOP_SECONDS = 60;
const TAU = Math.PI * 2;

/** A still pose for Reduce Motion: lobes spread, the core in front. */
export const STILL_PHASE = 0.9;

type Vec3 = [number, number, number];

/** The lobes at rest: direction (yaw, pitch), twist, and length. Alternating up and down. */
const LOBES: readonly { yaw: number; pitch: number; roll: number; length: number }[] = [
  { yaw: 0.7, pitch: 0.5, roll: 0.2, length: 0.42 },
  { yaw: 2.3, pitch: -0.48, roll: 1.3, length: 0.39 },
  { yaw: 3.85, pitch: 0.46, roll: 2.2, length: 0.41 },
  { yaw: 5.4, pitch: -0.52, roll: 3.0, length: 0.38 },
];

/** Advances a phase by `seconds` at `cyclesPerSecond`, wrapped to [0, 2π). */
export function advancePhase(phase: number, seconds: number, cyclesPerSecond: number): number {
  'worklet';
  const next = phase + seconds * cyclesPerSecond * TAU;
  return next - Math.floor(next / TAU) * TAU;
}

/** Moves `value` toward `target`, covering about 63% of the gap every `tau` seconds. */
export function ease(value: number, target: number, seconds: number, tau: number): number {
  'worklet';
  return value + (target - value) * (1 - Math.exp(-seconds / tau));
}

function rotate(v: Vec3, spin: number, tilt: number, lean: number): Vec3 {
  'worklet';
  // Spin about the vertical axis, then tilt toward the viewer, then lean sideways.
  let c = Math.cos(spin);
  let s = Math.sin(spin);
  const x1 = c * v[0] + s * v[2];
  const z1 = -s * v[0] + c * v[2];
  const y1 = v[1];
  c = Math.cos(tilt);
  s = Math.sin(tilt);
  const y2 = c * y1 - s * z1;
  const z2 = s * y1 + c * z1;
  c = Math.cos(lean);
  s = Math.sin(lean);
  return [c * x1 - s * y2, s * x1 + c * y2, z2];
}

export type JellyState = {
  /** Slow phase, radians in [0, 2π): one loop. */
  phase: number;
  /** Fast phase, radians in [0, 2π): one second. */
  pulse: number;
  energy: number;
  ripple: number;
  swell: number;
};

/** The shader's uniforms for one frame of a `size`-point square canvas. */
export function jellyUniforms(state: JellyState, size: number): Record<string, number | number[]> {
  'worklet';
  const { phase: ph, pulse, energy, ripple, swell } = state;
  const spin = 2 * ph;
  const tilt = 0.42 + 0.18 * Math.sin(3 * ph);
  const lean = 0.22 * Math.sin(2 * ph + 0.7);
  const out: Record<string, number | number[]> = {
    res: [size, size],
    lift: 0.035 * Math.sin(8 * ph),
    scale: 1 + 0.022 * Math.sin(15 * ph) + swell * 0.028 * Math.sin(2 * pulse),
    core: 0.32 + 0.02 * Math.sin(11 * ph + 0.4),
    wob: 0.022 + 0.05 * energy,
    wp: [7 * ph, 9 * ph + 1.3, 11 * ph + 2.6],
    ripple: 0.026 * ripple,
    rp: 3 * pulse,
  };
  for (let i = 0; i < LOBES.length; i++) {
    const lobe = LOBES[i];
    const yaw = lobe.yaw + energy * 0.35 * Math.sin((5 + i) * ph + 1.7 * i);
    const pitch = lobe.pitch + energy * 0.25 * Math.sin((6 + i) * ph + i);
    const roll = lobe.roll + (0.3 + energy * 0.6) * Math.sin((4 + i) * ph + 2.3 * i);
    const length = lobe.length * (1 + (0.04 + 0.06 * energy) * Math.sin((9 + i) * ph + i));
    const curl = 0.35 + 0.2 * Math.sin((3 + i) * ph + 0.9 * i);
    // Lobe frame: u along the lobe, w across its thin side, v across its width.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const u: Vec3 = [cp * cy, sp, cp * sy];
    const side: Vec3 = [-sy, 0, cy];
    const up: Vec3 = [-cy * sp, cp, -sy * sp];
    const w: Vec3 = [cr * up[0] + sr * side[0], cr * up[1] + sr * side[1], cr * up[2] + sr * side[2]];
    const v: Vec3 = [cr * side[0] - sr * up[0], cr * side[1] - sr * up[1], cr * side[2] - sr * up[2]];
    out[`u${i}`] = rotate(u, spin, tilt, lean);
    out[`v${i}`] = rotate(v, spin, tilt, lean);
    out[`w${i}`] = rotate(w, spin, tilt, lean);
    out[`d${i}`] = [length, 0.37, 0.165, curl];
  }
  return out;
}
