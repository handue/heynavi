import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia';
import { useIsFocused } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue } from 'react-native-reanimated';

import { DRIVE, LOOP_SECONDS, STILL_PHASE, advancePhase, ease, orbUniforms, type OrbMode, type OrbState } from '@/components/orb-motion';
import { ORB_SKSL } from '@/components/orb-shader';
import { micLevelValue } from '@/voice/mic-level';

export type { OrbMode } from '@/components/orb-motion';

function compile() {
  const effect = Skia.RuntimeEffect.Make(ORB_SKSL);
  if (!effect) throw new Error('The HeyNavi symbol shader did not compile.');
  return effect;
}

const EFFECT = compile();

/** Development builds log the symbol's frame rate every 10 s while it animates. */
const MEASURE = __DEV__;
const PERF_INTERVAL_MS = 10_000;

/**
 * The HeyNavi symbol (wireframes 01, 02 and 09): a living frosted glass orb with two eyes and a
 * blue glow, drawn by a GPU shader (orb-shader.ts) and moved each frame on the UI thread
 * (orb-motion.ts). It floats and breathes while its eyes glance around and blink.
 *
 * - idle: slow and calm, glancing side to side.
 * - listening: eyes straight ahead on the user, with a ripple and glow that follow the microphone
 *   level.
 * - thinking (an answer is on its way): eyes look up, the outline moves more.
 * - speaking: livelier, with a gentle swell.
 *
 * Mode changes ease in, so the motion never jumps. It only runs while its screen is focused (the
 * Home symbol stops under the camera screen); with Reduce Motion on it holds a still pose.
 * Decorative: hidden from VoiceOver (the button around it carries the label).
 */
export function Orb({ size = 120, mode = 'idle' }: { size?: number; mode?: OrbMode }) {
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const target = useSharedValue(DRIVE[mode]);
  const listening = useSharedValue(mode === 'listening');
  const speed = useSharedValue(DRIVE[mode].speed);
  const state = useSharedValue<OrbState>({ phase: STILL_PHASE, pulse: 0, ...DRIVE[mode] });
  const perf = useSharedValue({ frames: 0, slow: 0, worstMs: 0 });

  useEffect(() => {
    target.value = DRIVE[mode];
    listening.value = mode === 'listening';
  }, [mode, target, listening]);

  const frame = useFrameCallback((info) => {
    const ms = info.timeSincePreviousFrame ?? 16.7;
    const dt = Math.min(0.1, ms / 1000);
    const goal = target.value;
    const now = state.value;
    speed.value = ease(speed.value, goal.speed, dt, 0.8);
    const ripple = goal.ripple + (listening.value ? micLevelValue.value * 0.8 : 0);
    state.value = {
      phase: advancePhase(now.phase, dt, speed.value / LOOP_SECONDS),
      pulse: advancePhase(now.pulse, dt, 1),
      energy: ease(now.energy, goal.energy, dt, 0.6),
      ripple: ease(now.ripple, ripple, dt, 0.25),
      swell: ease(now.swell, goal.swell, dt, 0.4),
      up: ease(now.up, goal.up, dt, 0.5),
      attend: ease(now.attend, goal.attend, dt, 0.4),
    };
    if (MEASURE && info.timeSincePreviousFrame != null) {
      const p = perf.value;
      perf.value = { frames: p.frames + 1, slow: p.slow + (ms > 25 ? 1 : 0), worstMs: Math.max(p.worstMs, ms) };
    }
  }, false);

  // Off screen it pauses where it is (no jump when the screen comes back); Reduce Motion holds the
  // still pose.
  const animate = focused && !reduceMotion;
  useEffect(() => {
    frame.setActive(animate);
    if (reduceMotion) state.value = { phase: STILL_PHASE, pulse: 0, ...DRIVE.idle };
  }, [animate, reduceMotion, frame, state]);

  useEffect(() => {
    if (!MEASURE || !animate) return;
    const started = { at: performance.now() };
    const timer = setInterval(() => {
      const { frames, slow, worstMs } = perf.value;
      const seconds = (performance.now() - started.at) / 1000;
      started.at = performance.now();
      perf.value = { frames: 0, slow: 0, worstMs: 0 };
      if (frames > 0) {
        console.log(`[heynavi-perf] symbol size=${size} fps=${(frames / seconds).toFixed(1)} slow=${slow} worstMs=${worstMs.toFixed(0)}`);
      }
    }, PERF_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animate, perf, size]);

  const uniforms = useDerivedValue(() => orbUniforms(state.value, size));

  return (
    <View
      style={{ width: size, height: size }}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Canvas style={{ width: size, height: size }}>
        <Fill>
          <Shader source={EFFECT} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  );
}
