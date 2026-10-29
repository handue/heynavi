/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRecognizerActive, mergeActivity } from './stt-activity.ts';

const fold = (samples: (boolean | null)[]) => samples.reduce(mergeActivity, null);

describe('speech recognition activity during a capture run', () => {
  it('treats every state but "inactive" as active', () => {
    assert.equal(isRecognizerActive('inactive'), false);
    for (const state of ['starting', 'recognizing', 'stopping']) {
      assert.equal(isRecognizerActive(state), true);
    }
  });

  it('is true once any sample was active', () => {
    assert.equal(fold([false, true, false]), true);
    assert.equal(fold([true, null]), true);
  });

  it('is false when samples were read and none was active', () => {
    assert.equal(fold([false, false]), false);
    assert.equal(fold([null, false, null]), false);
  });

  it('is null when nothing could be read (Expo Go)', () => {
    assert.equal(fold([]), null);
    assert.equal(fold([null, null]), null);
  });
});
