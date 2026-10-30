/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDENTITY, PORTRAIT_FOV, integrate, shiftForRotation, turnAngle, turnSince, type Quaternion } from './motion.ts';

const DEG = Math.PI / 180;

/** Turning at a steady `degPerSecond` about one device axis for one second, in 30 Hz steps. */
function turned(axis: 'x' | 'y' | 'z', degrees: number): Quaternion {
  let q = IDENTITY;
  const rate = { x: 0, y: 0, z: 0, [axis]: degrees * DEG };
  for (let i = 0; i < 30; i++) q = integrate(q, rate, 1 / 30);
  return q;
}

describe('box motion', () => {
  it('leaves boxes where they are when the phone has not turned', () => {
    const shift = shiftForRotation(turnSince(IDENTITY, IDENTITY), 0.3, 0.7, PORTRAIT_FOV);
    assert.ok(Math.abs(shift.du) < 1e-12 && Math.abs(shift.dv) < 1e-12 && shift.visible);
  });

  it('integrates the gyroscope into the angle turned', () => {
    assert.ok(Math.abs(turnAngle(turnSince(IDENTITY, turned('y', 10))) - 10 * DEG) < 1e-9);
  });

  it('moves objects right when the phone turns left, by the field of view', () => {
    // Turning left is positive about the device's y axis (toward the top of the phone).
    const shift = shiftForRotation(turnSince(IDENTITY, turned('y', 5)), 0.5, 0.5, PORTRAIT_FOV);
    const expected = Math.tan(5 * DEG) / (2 * PORTRAIT_FOV.tanHalfX);
    assert.ok(Math.abs(shift.du - expected) < 1e-9, `${shift.du} vs ${expected}`);
    assert.ok(Math.abs(shift.dv) < 1e-9);
  });

  it('moves objects down when the camera tilts up', () => {
    // The top of the phone toward the user (positive about x) points the back camera up.
    const shift = shiftForRotation(turnSince(IDENTITY, turned('x', 4)), 0.5, 0.5, PORTRAIT_FOV);
    assert.ok(shift.dv > 0 && Math.abs(shift.dv - Math.tan(4 * DEG) / (2 * PORTRAIT_FOV.tanHalfY)) < 1e-9);
    assert.ok(Math.abs(shift.du) < 1e-9);
  });

  it('turns the view around its center when the phone rolls', () => {
    // Rolling counterclockwise (positive about z): a point on the right moves down, the center stays.
    assert.ok(shiftForRotation(turnSince(IDENTITY, turned('z', 6)), 0.9, 0.5, PORTRAIT_FOV).dv > 0);
    const center = shiftForRotation(turnSince(IDENTITY, turned('z', 6)), 0.5, 0.5, PORTRAIT_FOV);
    assert.ok(Math.abs(center.du) < 1e-9 && Math.abs(center.dv) < 1e-9);
  });

  it('measures the turn from when the frame was taken, not from the start', () => {
    const then = turned('y', 20);
    let now = then;
    for (let i = 0; i < 30; i++) now = integrate(now, { x: 0, y: -3 * DEG, z: 0 }, 1 / 30);
    const shift = shiftForRotation(turnSince(then, now), 0.5, 0.5, PORTRAIT_FOV);
    assert.ok(shift.du < 0 && Math.abs(shift.du + Math.tan(3 * DEG) / (2 * PORTRAIT_FOV.tanHalfX)) < 1e-6);
  });

  it('hides boxes once the phone has turned too far to trust them', () => {
    assert.equal(shiftForRotation(turnSince(IDENTITY, turned('y', 40)), 0.5, 0.5, PORTRAIT_FOV).visible, false);
  });
});
