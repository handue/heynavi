/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIRM, bestCandidate, candidates, confirm, largest, nearestCandidate } from './confirm.ts';
import { det } from './test-helpers.ts';

describe('CONFIRM', () => {
  it('has the ARCHITECTURE 4.2 initial values', () => {
    assert.deepEqual(CONFIRM, {
      tauDetect: 0.4,
      tauConfirm: 0.5,
      windowSize: 3,
      required: 2,
      maxCenterSpread: 0.25,
    });
  });
});

describe('candidates', () => {
  it('keeps detections at or above tau, best first, and never a null confidence', () => {
    const found = candidates([det(0.2, 0.39), det(0.5, null), det(0.8, 0.4), det(0.4, 0.9)]);
    assert.deepEqual(
      found.map((d) => d.confidence),
      [0.9, 0.4],
    );
    assert.equal(bestCandidate([det(0.5, null)]), null);
    assert.equal(bestCandidate([det(0.5, 0.41), det(0.1, 0.7)])?.center_x, 0.1);
  });
});

describe('confirm', () => {
  it('confirms 2 of 3 frames whose centers agree', () => {
    const result = confirm([[det(0.2, 0.6)], [], [det(0.3, 0.7)]]);
    assert.ok(result);
    assert.equal(result.detection.center_x, 0.3, 'the newest agreeing detection');
    assert.deepEqual(result.frames, [0, 2]);
  });

  it('accepts centers exactly 0.25 apart and rejects wider ones', () => {
    assert.ok(confirm([[det(0.2, 0.6)], [det(0.45, 0.6)]]));
    assert.equal(confirm([[det(0.2, 0.6)], [det(0.46, 0.6)]]), null);
  });

  it('needs tau_confirm in every agreeing frame (candidates alone are not enough)', () => {
    assert.equal(confirm([[det(0.5, 0.45)], [det(0.5, 0.9)]]), null);
    assert.ok(confirm([[det(0.5, 0.5)], [det(0.5, 0.5)]]));
  });

  it('never confirms on null confidence', () => {
    assert.equal(confirm([[det(0.5, null)], [det(0.5, null)], [det(0.5, null)]]), null);
  });

  it('does not count two detections in the same frame as two frames', () => {
    assert.equal(confirm([[det(0.5, 0.9), det(0.55, 0.9)], [], []]), null);
  });

  it('only looks at the last 3 frames', () => {
    assert.equal(confirm([[det(0.5, 0.9)], [], [], [det(0.5, 0.9)]]), null);
    assert.ok(confirm([[], [det(0.5, 0.9)], [], [det(0.5, 0.9)]]));
  });

  it('matches spatially across several instances', () => {
    // Left chair in frame 0, right chair in frame 1, left chair again in frame 2.
    const result = confirm([[det(0.15, 0.8)], [det(0.85, 0.8)], [det(0.2, 0.6), det(0.85, 0.55)]]);
    assert.ok(result);
    // Both groups reach the newest frame; the more confident newest member wins.
    assert.equal(result.detection.center_x, 0.2);
  });

  it('rejects one-frame evidence', () => {
    assert.equal(confirm([[det(0.5, 0.99)]]), null);
    assert.equal(confirm([]), null);
  });
});

describe('nearestCandidate and largest', () => {
  it('follows the tracked object instead of the most confident one', () => {
    const detections = [det(0.8, 0.95), det(0.3, 0.5)];
    assert.equal(nearestCandidate(detections, 0.25)?.center_x, 0.3);
    assert.equal(nearestCandidate(detections, null)?.center_x, 0.8);
    assert.equal(nearestCandidate([det(0.3, 0.2)], 0.3), null, 'below tau_detect');
  });

  it('picks the largest box', () => {
    assert.equal(largest([det(0.2, 0.9, 0.05), det(0.5, 0.6, 0.3)])?.center_x, 0.5);
    assert.equal(largest([]), null);
  });
});
