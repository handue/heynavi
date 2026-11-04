/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDENTITY, PORTRAIT_FOV, UNKNOWN_TURN, integrate, shiftForRotation, turnAngle, type Quaternion } from './motion.ts';
import { TURN_HISTORY_MS, createTurnHistory } from './turn-history.ts';

const DEG = Math.PI / 180;

/** Feeds `seconds` of turning left at `degPerSecond` (30 Hz), starting at `from` ms; returns the attitude. */
function turn(history: ReturnType<typeof createTurnHistory>, from: number, seconds: number, degPerSecond: number, start = IDENTITY) {
  let q: Quaternion = start;
  for (let i = 1; i <= seconds * 30; i++) {
    q = integrate(q, { x: 0, y: degPerSecond * DEG, z: 0 }, 1 / 30);
    history.push(from + (i * 1000) / 30, q);
  }
  return q;
}

describe('turn history', () => {
  it('has no answer before the gyroscope reports', () => {
    assert.equal(createTurnHistory().since(0, IDENTITY), null);
  });

  it('measures the turn since a frame from the sample taken at or before it', () => {
    const history = createTurnHistory();
    const now = turn(history, 0, 4, 5); // 20 degrees over 4 s
    const since = history.since(2000, now);
    assert.ok(since && Math.abs(turnAngle(since) - 10 * DEG) < 0.3 * DEG, `${since && turnAngle(since) / DEG}`);
  });

  it('keeps a box corrected for a reply that comes 17 s after its frame (walk of 2026-11-03)', () => {
    const history = createTurnHistory();
    const now = turn(history, 0, 17, 1); // 17 degrees in 17 s
    const since = history.since(10, now);
    assert.ok(since && Math.abs(turnAngle(since) - 17 * DEG) < 0.3 * DEG);
    assert.ok(TURN_HISTORY_MS >= 30_000, 'covers a failed look too');
  });

  it('hides boxes of a frame older than the history instead of snapping them back', () => {
    const history = createTurnHistory(10_000);
    const now = turn(history, 0, 12, 1); // trims the first 2 s
    assert.equal(history.since(1000, now), UNKNOWN_TURN);
    assert.equal(shiftForRotation(UNKNOWN_TURN, 0.5, 0.5, PORTRAIT_FOV).visible, false);
  });

  it('measures a frame taken just before the first sample from that sample', () => {
    const history = createTurnHistory();
    const now = turn(history, 1000, 1, 6);
    const since = history.since(990, now);
    assert.ok(since && Math.abs(turnAngle(since) - 6 * DEG) < 0.5 * DEG);
  });

  it('starts over after a gap in the samples, so the first look after the background keeps its boxes', () => {
    const history = createTurnHistory();
    turn(history, 0, 10, 2);
    // 60 s in the background, then the first look is taken just before the first new sample.
    const now = turn(history, 70_020, 1, 3);
    const since = history.since(70_000, now);
    assert.ok(since && since !== UNKNOWN_TURN && Math.abs(turnAngle(since) - 3 * DEG) < 0.5 * DEG);
  });

  it('starts over after clear()', () => {
    const history = createTurnHistory(1000);
    turn(history, 0, 2, 5);
    history.clear();
    assert.equal(history.since(0, IDENTITY), null);
    const now = turn(history, 5000, 1, 5);
    // Not trimmed since the clear: a frame from just before the new samples is measured from them.
    assert.notEqual(history.since(4999, now), UNKNOWN_TURN);
  });
});
