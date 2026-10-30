/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DRIVE, LOOP_SECONDS, advancePhase, ease, jellyUniforms, type JellyState } from './jelly-motion.ts';
import { JELLY_SKSL } from './jelly-shader.ts';

const TAU = Math.PI * 2;
const DECLARED = [...JELLY_SKSL.matchAll(/uniform\s+float(\d?)\s+(\w+);/g)].map((m) => ({ name: m[2], size: Number(m[1] || 1) }));

function state(phase: number, mode: keyof typeof DRIVE = 'idle'): JellyState {
  return { phase, pulse: 0.4, ...DRIVE[mode] };
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('jelly motion', () => {
  it('wraps both phases into [0, 2π), even after long frames', () => {
    assert.equal(advancePhase(TAU - 0.01, 0.5, 1), advancePhase(TAU - 0.01, 0.5, 1) % TAU);
    for (const seconds of [0, 0.016, 1, 59.9, 600]) {
      const phase = advancePhase(1, seconds, 1 / LOOP_SECONDS);
      assert.ok(phase >= 0 && phase < TAU, `${seconds} s`);
    }
  });

  it('gives every uniform the shader declares, with the right size and finite values', () => {
    assert.ok(DECLARED.length > 10);
    for (const mode of Object.keys(DRIVE) as (keyof typeof DRIVE)[]) {
      const uniforms = jellyUniforms(state(2.1, mode), 136);
      assert.deepEqual(Object.keys(uniforms).sort(), DECLARED.map((u) => u.name).sort());
      for (const { name, size } of DECLARED) {
        const values = ([] as number[]).concat(uniforms[name]);
        assert.equal(values.length, size, name);
        assert.ok(values.every(Number.isFinite), name);
      }
    }
  });

  it('loops seamlessly: the end of the loop is its start', () => {
    // wp and rp are angles the shader only takes the sine of: compared on the circle.
    const angles = new Set(['wp', 'rp']);
    for (const mode of Object.keys(DRIVE) as (keyof typeof DRIVE)[]) {
      const start = jellyUniforms(state(0, mode), 100);
      const end = jellyUniforms(state(TAU, mode), 100);
      for (const name of Object.keys(start)) {
        const a = ([] as number[]).concat(start[name]);
        const b = ([] as number[]).concat(end[name]);
        a.forEach((value, i) => {
          const gap = angles.has(name) ? Math.abs(Math.sin((value - b[i]) / 2)) : Math.abs(value - b[i]);
          assert.ok(gap < 1e-9, `${mode} ${name}`);
        });
      }
    }
  });

  it('keeps each lobe frame orthonormal as it turns', () => {
    for (const phase of [0, 0.7, 2.5, 4.4, 6.1]) {
      const uniforms = jellyUniforms(state(phase, 'thinking'), 100);
      for (let i = 0; i < 4; i++) {
        const [u, v, w] = [`u${i}`, `v${i}`, `w${i}`].map((name) => uniforms[name] as number[]);
        for (const axis of [u, v, w]) assert.ok(Math.abs(dot(axis, axis) - 1) < 1e-9);
        assert.ok(Math.abs(dot(u, v)) < 1e-9 && Math.abs(dot(u, w)) < 1e-9 && Math.abs(dot(v, w)) < 1e-9);
      }
    }
  });

  it('turns calmly at rest and livelier while thinking or speaking', () => {
    // One full turn per 30 s at idle: never a fast spin.
    assert.equal((LOOP_SECONDS / DRIVE.idle.speed) / 2, 30);
    assert.ok(DRIVE.thinking.energy > DRIVE.idle.energy && DRIVE.speaking.energy > DRIVE.idle.energy);
    assert.ok(Math.max(...Object.values(DRIVE).map((d) => d.speed)) <= 1.5);
  });

  it('eases toward a new mode instead of jumping', () => {
    const step = ease(0.25, 0.65, 1 / 60, 0.6);
    assert.ok(step > 0.25 && step < 0.27);
    assert.ok(Math.abs(ease(0.25, 0.65, 10, 0.6) - 0.65) < 1e-6);
  });
});
