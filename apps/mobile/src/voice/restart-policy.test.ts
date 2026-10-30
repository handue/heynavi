/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// restartDelayMs / nextErrorStreak keep their coverage in diagnostics/stt-restart.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_ERROR_STREAK, MIN_HEALTHY_SESSION_MS, planRestart, type RestartInput } from './restart-policy.ts';

const base: RestartInput = { attempt: 0, streak: 0, error: null, hadResult: false, sessionMs: 60_000 };

describe('planRestart', () => {
  it('restarts a healthy session at once and without counting it as a failure', () => {
    for (const input of [
      { ...base, hadResult: true, error: 'network' as const },
      { ...base, error: 'no-speech' as const },
      { ...base, error: null },
      { ...base, attempt: 3, streak: 2, error: 'no-speech' as const },
    ]) {
      assert.deepEqual(planRestart(input), { giveUp: false, delayMs: 250, attempt: 0, streak: 0 });
    }
  });

  it('a quiet room never makes the listener give up', () => {
    let state = { attempt: 0, streak: 0 };
    for (let i = 0; i < 50; i++) {
      const plan = planRestart({ ...base, ...state, error: 'no-speech', sessionMs: 30_000 });
      assert.equal(plan.giveUp, false);
      if (!plan.giveUp) state = { attempt: plan.attempt, streak: plan.streak };
    }
  });

  it('backs off on failures and gives up after the streak limit', () => {
    let state = { attempt: 0, streak: 0 };
    const delays: number[] = [];
    let gaveUp = false;
    for (let i = 0; i < 10 && !gaveUp; i++) {
      const plan = planRestart({ ...base, ...state, error: 'audio-capture', sessionMs: 50 });
      if (plan.giveUp) {
        gaveUp = true;
        assert.equal(plan.streak, MAX_ERROR_STREAK);
      } else {
        delays.push(plan.delayMs);
        state = { attempt: plan.attempt, streak: plan.streak };
      }
    }
    assert.equal(gaveUp, true);
    assert.deepEqual(delays, [250, 500, 1000, 2000]);
  });

  it('counts a session that ended at once as a failure, even without an error', () => {
    const plan = planRestart({ ...base, error: null, sessionMs: MIN_HEALTHY_SESSION_MS - 1 });
    assert.deepEqual(plan, { giveUp: false, delayMs: 250, attempt: 1, streak: 1 });
    const silent = planRestart({ ...base, error: 'no-speech', sessionMs: 100 });
    assert.equal(silent.giveUp === false && silent.streak, 1);
  });

  it('waits longer after "busy"', () => {
    const plan = planRestart({ ...base, error: 'busy', sessionMs: 10 });
    assert.equal(plan.giveUp === false && plan.delayMs, 1000);
  });
});
