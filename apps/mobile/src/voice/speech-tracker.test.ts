/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { watchdogMs, type SpeakCallbacks, type Speaker } from '../agent/announcer.ts';
import { TRACKER_SLACK_MS, createSpeechTracker, type SpeechEvent } from './speech-tracker.ts';

function harness() {
  let time = 0;
  const pending: SpeakCallbacks[] = [];
  const inner: Speaker = {
    speak(_text, _lang, callbacks) {
      pending.push(callbacks);
    },
    stop() {
      // Like expo-speech: everything playing or queued reports onStopped.
      for (const callbacks of pending.splice(0)) callbacks.onStopped();
    },
  };
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const tracker = createSpeechTracker(inner, {
    now: () => time,
    setTimer: (fn, ms) => {
      const timer = { fn, at: time + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  });
  const events: SpeechEvent[] = [];
  tracker.subscribe((e) => events.push(e));
  return {
    tracker,
    events,
    pending,
    advance(ms: number) {
      time += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= time) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
  };
}

const noop: SpeakCallbacks = { onDone: () => {}, onStopped: () => {} };

describe('speech tracker', () => {
  it('is speaking from speak() until onDone, and remembers the last utterance', () => {
    const h = harness();
    let done = 0;
    h.tracker.speaker.speak('Looking for a chair.', 'en-US', { onDone: () => done++, onStopped: () => {} });
    assert.equal(h.tracker.speaking, true);
    assert.equal(h.tracker.currentText, 'Looking for a chair.');
    assert.deepEqual(h.tracker.activeIds(), [1]);
    h.advance(1500);
    h.pending.shift()!.onDone();
    assert.equal(done, 1, 'the announcer still gets its callback');
    assert.equal(h.tracker.speaking, false);
    assert.equal(h.tracker.currentText, null);
    assert.equal(h.tracker.lastText, 'Looking for a chair.');
    assert.equal(h.tracker.lastEndedAt, 1500);
    assert.deepEqual(
      h.events.map((e) => `${e.type}:${e.id}@${e.at}`),
      ['start:1@0', 'end:1@1500'],
    );
  });

  it('ends on onStopped after stop(), and tracks a hand-over between two utterances', () => {
    const h = harness();
    h.tracker.speaker.speak('first', 'en-US', noop);
    h.tracker.speaker.speak('second', 'en-US', noop);
    assert.deepEqual(h.tracker.activeIds(), [1, 2]);
    assert.equal(h.tracker.currentText, 'second');
    h.advance(80);
    h.tracker.speaker.stop();
    assert.equal(h.tracker.speaking, false);
    assert.deepEqual(
      h.events.filter((e) => e.type === 'end').map((e) => e.id),
      [1, 2],
    );
  });

  it('cannot get stuck "speaking" when the end is never reported', () => {
    const h = harness();
    h.tracker.speaker.speak('lost', 'en-US', noop);
    h.advance(watchdogMs('lost') + TRACKER_SLACK_MS - 1);
    assert.equal(h.tracker.speaking, true);
    h.advance(1);
    assert.equal(h.tracker.speaking, false);
    // A late callback after that changes nothing.
    h.pending.shift()!.onDone();
    assert.equal(h.events.filter((e) => e.type === 'end').length, 1);
  });
});
