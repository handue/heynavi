/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BLINKS_PER_LOOP, DRIVE, LOOP_SECONDS, STILL_PHASE, advancePhase, ease, orbUniforms, type OrbState } from './orb-motion.ts';
import { ORB_SKSL } from './orb-shader.ts';

const TAU = Math.PI * 2;
const DECLARED = [...ORB_SKSL.matchAll(/uniform\s+float(\d?)\s+(\w+);/g)].map((m) => ({ name: m[2], size: Number(m[1] || 1) }));
const MODES = Object.keys(DRIVE) as (keyof typeof DRIVE)[];

function state(phase: number, mode: keyof typeof DRIVE = 'idle'): OrbState {
  return { phase, pulse: 0.4, ...DRIVE[mode] };
}

function values(uniforms: Record<string, number | number[]>, name: string): number[] {
  return ([] as number[]).concat(uniforms[name]);
}

describe('orb motion', () => {
  it('wraps both phases into [0, 2π), even after long frames', () => {
    assert.equal(advancePhase(TAU - 0.01, 0.5, 1), advancePhase(TAU - 0.01, 0.5, 1) % TAU);
    for (const seconds of [0, 0.016, 1, 59.9, 600]) {
      const phase = advancePhase(1, seconds, 1 / LOOP_SECONDS);
      assert.ok(phase >= 0 && phase < TAU, `${seconds} s`);
    }
  });

  it('gives every uniform the shader declares, with the right size and finite values', () => {
    assert.ok(DECLARED.length >= 10);
    for (const mode of MODES) {
      const uniforms = orbUniforms(state(2.1, mode), 136);
      assert.deepEqual(Object.keys(uniforms).sort(), DECLARED.map((u) => u.name).sort());
      for (const { name, size } of DECLARED) {
        assert.equal(values(uniforms, name).length, size, name);
        assert.ok(values(uniforms, name).every(Number.isFinite), name);
      }
    }
  });

  it('loops seamlessly: the end of the loop is its start', () => {
    // Phases the shader only takes the sine of are compared on the circle.
    const angles: Record<string, number[]> = { rp: [0], shape: [1, 3] };
    for (const mode of MODES) {
      const start = orbUniforms(state(0, mode), 100);
      const end = orbUniforms(state(TAU, mode), 100);
      for (const name of Object.keys(start)) {
        const b = values(end, name);
        values(start, name).forEach((value, i) => {
          const gap = angles[name]?.includes(i) ? Math.abs(Math.sin((value - b[i]) / 2)) : Math.abs(value - b[i]);
          assert.ok(gap < 1e-9, `${mode} ${name}`);
        });
      }
    }
  });

  it('keeps the orb and its halo inside the canvas, with a gentle wobble', () => {
    for (const mode of MODES) {
      for (let phase = 0; phase < TAU; phase += 0.05) {
        const u = orbUniforms({ ...state(phase, mode), pulse: phase * 7, ripple: 1 }, 100);
        const [cx, cy] = values(u, 'center');
        const [a2, , a3] = values(u, 'shape');
        const outline = 1 + a2 + a3 + (u.ripple as number);
        assert.ok(outline < 1.06, `${mode} wobble`);
        assert.ok((u.radius as number) * outline + Math.hypot(cx, cy) < 0.72, `${mode} orb`);
        const [tx, ty] = values(u, 'tint');
        assert.ok(Math.abs(Math.hypot(tx, ty) - 1) < 1e-9 && tx > 0 && ty < 0, `${mode} tint from the bottom right`);
      }
    }
  });

  it('blinks briefly and keeps the eyes within the orb', () => {
    let closed = 0;
    const samples = 6000;
    for (let i = 0; i < samples; i++) {
      const u = orbUniforms(state((i / samples) * TAU, 'idle'), 100);
      const open = u.open as number;
      assert.ok(open >= 0 && open <= 1);
      if (open < 0.5) closed += 1;
      for (const mode of MODES) {
        const [x, y] = values(orbUniforms(state((i / samples) * TAU, mode), 100), 'look');
        assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, mode);
      }
    }
    // Each blink is about a fifth of a second; about one every 4.6 s at rest.
    const blinkSeconds = (closed / samples) * LOOP_SECONDS / BLINKS_PER_LOOP;
    assert.ok(blinkSeconds > 0.08 && blinkSeconds < 0.3, `${blinkSeconds.toFixed(3)} s per blink`);
  });

  it('holds still with open eyes looking ahead for Reduce Motion, and looks up while thinking', () => {
    const still = orbUniforms(state(STILL_PHASE, 'idle'), 100);
    assert.equal(still.open, 1);
    assert.ok(values(still, 'look').every((v) => Math.abs(v) < 1e-9));
    for (const phase of [0.3, 1.7, 4.2]) {
      const thinking = values(orbUniforms(state(phase, 'thinking'), 100), 'look');
      const listening = values(orbUniforms(state(phase, 'listening'), 100), 'look');
      assert.ok(thinking[1] > 0.6, 'thinking looks up');
      assert.ok(Math.hypot(...listening) < 0.2, 'listening looks at the user');
    }
  });

  it('moves calmly at rest and livelier while thinking or speaking', () => {
    assert.ok(DRIVE.thinking.energy > DRIVE.idle.energy && DRIVE.speaking.energy > DRIVE.idle.energy);
    assert.ok(Math.max(...Object.values(DRIVE).map((d) => d.speed)) <= 1.5);
  });

  it('eases toward a new mode instead of jumping', () => {
    const step = ease(0.25, 0.65, 1 / 60, 0.6);
    assert.ok(step > 0.25 && step < 0.27);
    assert.ok(Math.abs(ease(0.25, 0.65, 10, 0.6) - 0.65) < 1e-6);
  });
});
