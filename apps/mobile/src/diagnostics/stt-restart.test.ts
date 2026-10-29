/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ERROR_STREAK,
  isSelfInflictedAbort,
  nextErrorStreak,
  restartDelayMs,
} from './stt-restart.ts';

describe('restartDelayMs', () => {
  it('doubles from 250 ms and caps at 4 s', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 10].map((attempt) => restartDelayMs(attempt, 'no-speech')),
      [250, 500, 1000, 2000, 4000, 4000, 4000],
    );
    assert.equal(restartDelayMs(0, null), 250);
  });

  it('waits longer after "busy"', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 10].map((attempt) => restartDelayMs(attempt, 'busy')),
      [1000, 2000, 4000, 8000, 8000, 8000],
    );
    for (let attempt = 0; attempt < 8; attempt++) {
      assert.ok(restartDelayMs(attempt, 'busy') > restartDelayMs(attempt, 'network'));
    }
  });
});

describe('nextErrorStreak', () => {
  it('grows only for sessions that ended with an error and no result', () => {
    assert.equal(nextErrorStreak(0, { hadResult: false, error: 'no-speech' }), 1);
    assert.equal(nextErrorStreak(3, { hadResult: false, error: 'network' }), 4);
  });

  it('resets on a result or a clean end', () => {
    assert.equal(nextErrorStreak(4, { hadResult: true, error: 'no-speech' }), 0);
    assert.equal(nextErrorStreak(4, { hadResult: false, error: null }), 0);
  });

  it(`gives up after ${MAX_ERROR_STREAK} failed sessions, with growing delays before that`, () => {
    let streak = 0;
    let attempt = 0;
    const delays: number[] = [];
    for (let session = 1; session <= 10; session++) {
      streak = nextErrorStreak(streak, { hadResult: false, error: 'no-speech' });
      if (streak >= MAX_ERROR_STREAK) break;
      delays.push(restartDelayMs(attempt++, 'no-speech'));
    }
    assert.equal(streak, 5);
    assert.deepEqual(delays, [250, 500, 1000, 2000]);
  });

  it('a result in the middle starts the count again', () => {
    let streak = 0;
    for (let i = 0; i < 4; i++) streak = nextErrorStreak(streak, { hadResult: false, error: 'network' });
    streak = nextErrorStreak(streak, { hadResult: true, error: null });
    streak = nextErrorStreak(streak, { hadResult: false, error: 'network' });
    assert.equal(streak, 1);
  });
});

describe('isSelfInflictedAbort', () => {
  it('ignores "aborted" only after our own abort()', () => {
    assert.equal(isSelfInflictedAbort('aborted', true), true);
    assert.equal(isSelfInflictedAbort('aborted', false), false);
    assert.equal(isSelfInflictedAbort('network', true), false);
  });
});
