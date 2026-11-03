/**
 * How the HeyNavi symbol moves (shader: orb-shader.ts, component: orb.tsx). The frosted orb
 * floats and breathes, its outline wobbles a little, its blue glow drifts around it, and its eyes
 * glance about and blink.
 *
 * Everything is a function of two phases that wrap at 2π: `phase`, one loop of LOOP_SECONDS at
 * speed 1, where every slow motion completes a whole number of cycles, and `pulse`, one second,
 * for the listening ripple and the speaking swell. So the animation never visibly resets, and a
 * mode change only changes how fast the phases advance and how much the orb moves: no jumps.
 *
 * Pure functions marked as worklets: they run on the UI thread each frame, and in Node for tests
 * and the preview render.
 */

/** What the symbol shows: resting, hearing the user, working on an answer, or HeyNavi speaking. */
export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Per mode: phase speed (1 = one loop per LOOP_SECONDS), how much the orb moves, the ripple, the
 * speaking swell, how far the eyes look up (thinking), and how steadily they hold straight ahead
 * on the user (listening). Listening adds the microphone level to its ripple.
 */
export type Drive = { speed: number; energy: number; ripple: number; swell: number; up: number; attend: number };

export const DRIVE: Record<OrbMode, Drive> = {
  idle: { speed: 1, energy: 0.25, ripple: 0, swell: 0, up: 0, attend: 0 },
  listening: { speed: 1.15, energy: 0.4, ripple: 0.2, swell: 0, up: 0, attend: 1 },
  thinking: { speed: 1.4, energy: 0.65, ripple: 0, swell: 0, up: 1, attend: 0 },
  speaking: { speed: 1.5, energy: 0.6, ripple: 0.15, swell: 1, up: 0, attend: 0.5 },
};

export const LOOP_SECONDS = 60;
const TAU = Math.PI * 2;

/** The orb's radius at rest, in units of half the canvas: the rest of the canvas is its halo. */
export const ORB_RADIUS = 0.6;

/** Blinks per loop at speed 1: about one every 4.6 s at rest. */
export const BLINKS_PER_LOOP = 13;

/** A still pose for Reduce Motion: eyes open, looking straight ahead. */
export const STILL_PHASE = 0;

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

function smoothstep(lo: number, hi: number, x: number): number {
  'worklet';
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function clamp1(x: number): number {
  'worklet';
  return Math.min(1, Math.max(-1, x));
}

export type OrbState = {
  /** Slow phase, radians in [0, 2π): one loop. */
  phase: number;
  /** Fast phase, radians in [0, 2π): one second. */
  pulse: number;
  energy: number;
  ripple: number;
  swell: number;
  up: number;
  attend: number;
};

/** The shader's uniforms for one frame of a `size`-point square canvas. */
export function orbUniforms(state: OrbState, size: number): Record<string, number | number[]> {
  'worklet';
  const { phase: ph, pulse, energy, ripple, swell, up, attend } = state;
  const beat = 0.5 + 0.5 * Math.sin(2 * pulse);
  // The glow comes from the bottom right and drifts a little around it.
  const tintAngle = -0.93 + 0.22 * Math.sin(2 * ph + 1) + 0.25 * energy * Math.sin(5 * ph);
  // Gaze: holds to one side, moves across, holds to the other (a clipped sine), with a small
  // wander; looks up while thinking and straight ahead while listening.
  const hold = 1 - 0.8 * attend;
  const lookX = (0.7 * clamp1(1.6 * Math.sin(2 * ph)) + 0.12 * Math.sin(7 * ph)) * hold * (1 - 0.4 * up);
  const lookY = (0.3 * Math.sin(3 * ph)) * hold * (1 - up) + 0.75 * up;
  const blink = smoothstep(0.972, 0.998, Math.sin(BLINKS_PER_LOOP * ph));
  return {
    res: [size, size],
    center: [0.015 * Math.sin(5 * ph), 0.03 * Math.sin(8 * ph)],
    radius: ORB_RADIUS * (1 + 0.015 * Math.sin(15 * ph) + swell * 0.03 * (2 * beat - 1)),
    shape: [0.006 + 0.012 * energy, 4 * ph + 0.5, 0.003 + 0.006 * energy, 1.9 - 7 * ph],
    ripple: 0.01 * ripple,
    rp: 3 * pulse,
    tint: [Math.cos(tintAngle), Math.sin(tintAngle)],
    glow: 0.9 + 0.1 * Math.sin(6 * ph) + 0.5 * ripple + 0.15 * swell * beat,
    look: [lookX, lookY],
    open: 1 - blink,
  };
}
