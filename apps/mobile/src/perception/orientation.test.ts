/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyHold, meanGravity } from './orientation.ts';

const G = 9.80665;
/** Gravity for a phone upright in portrait, with the camera tilted `downDeg` below level. */
function tilted(downDeg: number, sideways = 0) {
  const r = (downDeg * Math.PI) / 180;
  return { x: sideways * G, y: -Math.cos(r) * G, z: -Math.sin(r) * G };
}

describe('classifyHold', () => {
  it('counts an upright, roughly level phone as held forward', () => {
    for (const deg of [0, 20, 50, -20]) assert.equal(classifyHold(tilted(deg)).frame, 'forward', `${deg}°`);
    assert.equal(classifyHold(tilted(30)).downDeg, 30);
  });

  it('falls back to camera-relative wording otherwise', () => {
    assert.equal(classifyHold(tilted(70)).reason, 'too-low');
    assert.equal(classifyHold(tilted(-40)).reason, 'too-high');
    assert.equal(classifyHold({ x: 0, y: 0, z: -G }).frame, 'camera', 'flat on its back');
    assert.equal(classifyHold({ x: -G, y: 0, z: 0 }).reason, 'sideways', 'landscape');
    assert.equal(classifyHold({ x: 0, y: G, z: 0 }).reason, 'not-upright', 'upside down');
    assert.equal(classifyHold({ x: 0, y: -2.5 * G, z: 0 }).reason, 'shaking');
  });

  it('averages samples', () => {
    assert.deepEqual(meanGravity([{ x: 0, y: -10, z: 0 }, { x: 2, y: -8, z: -2 }]), { x: 1, y: -9, z: -1 });
    assert.equal(meanGravity([]), null);
  });
});
