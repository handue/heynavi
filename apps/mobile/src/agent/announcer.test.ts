/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAnnouncer,
  watchdogMs,
  type Announcement,
  type DropReason,
  type SpeakCallbacks,
  type Speaker,
} from './announcer.ts';
import type { Priority } from './types.ts';

/** Speaker that records calls; like iOS, stop() fires onStopped for the current utterance. */
function harness() {
  let time = 0;
  const log: string[] = [];
  const drops: [string, DropReason][] = [];
  let pending: SpeakCallbacks | null = null;
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const speaker: Speaker = {
    speak(text, _lang, callbacks) {
      log.push(`speak:${text}`);
      pending = callbacks;
    },
    stop() {
      log.push('stop');
      const callbacks = pending;
      pending = null;
      callbacks?.onStopped();
    },
  };
  const announcer = createAnnouncer(speaker, {
    now: () => time,
    onDrop: (a, reason) => drops.push([a.key, reason]),
    setTimer: (fn, ms) => {
      const timer = { fn, at: time + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  });
  return {
    announcer,
    log,
    drops,
    /** The current utterance finishes normally. */
    finish() {
      const callbacks = pending;
      pending = null;
      callbacks?.onDone();
    },
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

function msg(key: string, priority: Priority, extra: Partial<Announcement> = {}): Announcement {
  return {
    key,
    priority,
    text: key,
    lang: 'en-US',
    ttlMs: 10_000,
    dedupeMs: 0,
    goalId: null,
    ...extra,
  };
}

describe('announcer queue', () => {
  it('speaks at once when idle, queues equal priority, then plays it after onDone', () => {
    const h = harness();
    assert.equal(h.announcer.announce(msg('a', 2)), true);
    h.announcer.announce(msg('b', 2));
    assert.deepEqual(h.log, ['speak:a']);
    assert.equal(h.announcer.speaking?.key, 'a');
    assert.deepEqual(h.announcer.queued.map((q) => q.key), ['b']);
    h.finish();
    assert.deepEqual(h.log, ['speak:a', 'speak:b']);
    h.finish();
    assert.equal(h.announcer.speaking, null);
  });

  it('orders the queue by priority, then arrival', () => {
    const h = harness();
    h.announcer.announce(msg('reply', 0));
    h.announcer.announce(msg('status-1', 2));
    h.announcer.announce(msg('event', 1));
    h.announcer.announce(msg('status-2', 2));
    for (let i = 0; i < 3; i++) h.finish();
    assert.deepEqual(h.log, ['speak:reply', 'speak:event', 'speak:status-1', 'speak:status-2']);
  });
});

describe('preemption', () => {
  it('a higher priority stops the current utterance first, then speaks', () => {
    const h = harness();
    h.announcer.announce(msg('coach', 2));
    h.announcer.announce(msg('found', 1));
    assert.deepEqual(h.log, ['speak:coach', 'stop', 'speak:found']);
    assert.deepEqual(h.drops, [['coach', 'preempted']]);
    // The late onStopped of the cut utterance must not end the new one.
    assert.equal(h.announcer.speaking?.key, 'found');
  });

  it('a lower or equal priority never interrupts', () => {
    const h = harness();
    h.announcer.announce(msg('found', 1));
    h.announcer.announce(msg('coach', 2));
    h.announcer.announce(msg('lost', 1));
    assert.deepEqual(h.log, ['speak:found']);
    h.finish();
    h.finish();
    assert.deepEqual(h.log, ['speak:found', 'speak:lost', 'speak:coach']);
  });
});

describe('dedupe', () => {
  it('suppresses the same key within its window after it was spoken', () => {
    const h = harness();
    h.announcer.announce(msg('found:g:left', 1, { dedupeMs: 20_000 }));
    h.finish();
    h.advance(19_999);
    assert.equal(h.announcer.announce(msg('found:g:left', 1, { dedupeMs: 20_000 })), false);
    h.advance(1);
    assert.equal(h.announcer.announce(msg('found:g:left', 1, { dedupeMs: 20_000 })), true);
    assert.deepEqual(h.log, ['speak:found:g:left', 'speak:found:g:left']);
    assert.deepEqual(h.drops, [['found:g:left', 'duplicate']]);
  });

  it('suppresses a key that is being spoken, and replaces a queued one with the newer text', () => {
    const h = harness();
    h.announcer.announce(msg('a', 1));
    assert.equal(h.announcer.announce(msg('a', 1)), false);
    h.announcer.announce(msg('guide', 2, { text: 'Now on the left.' }));
    h.announcer.announce(msg('guide', 2, { text: 'Centered.' }));
    h.finish();
    assert.deepEqual(h.log, ['speak:a', 'speak:Centered.']);
  });

  it('dedupeMs 0 never suppresses once the previous one ended', () => {
    const h = harness();
    h.announcer.announce(msg('guide', 2));
    h.finish();
    assert.equal(h.announcer.announce(msg('guide', 2)), true);
  });
});

describe('staleness', () => {
  it('drops announcements past their TTL while queued', () => {
    const h = harness();
    h.announcer.announce(msg('long', 1));
    h.announcer.announce(msg('guide', 2, { ttlMs: 2000 }));
    h.advance(2001);
    h.finish();
    assert.deepEqual(h.log, ['speak:long']);
    assert.deepEqual(h.drops, [['guide', 'expired']]);
  });

  it('drops announcements for another goal, and stops speech when the goal changes', () => {
    const h = harness();
    h.announcer.setGoal('g1');
    assert.equal(h.announcer.announce(msg('old', 1, { goalId: 'g0' })), false);
    h.announcer.announce(msg('start', 0, { goalId: 'g1' }));
    h.announcer.announce(msg('found', 1, { goalId: 'g1' }));
    h.announcer.announce(msg('free', 2));
    h.announcer.setGoal(null);
    // "start" is cut off, "found" never plays, the goal-free message still does.
    assert.deepEqual(h.log, ['speak:start', 'stop', 'speak:free']);
    assert.deepEqual(h.drops, [
      ['old', 'stale_goal'],
      ['found', 'stale_goal'],
      ['start', 'stale_goal'],
    ]);
  });
});

describe('watchdog, clear and repeat', () => {
  it('treats an utterance whose onDone never came as finished', () => {
    const h = harness();
    h.announcer.announce(msg('stuck', 2));
    h.announcer.announce(msg('next', 2));
    h.advance(watchdogMs('stuck'));
    assert.deepEqual(h.log, ['speak:stuck', 'stop', 'speak:next']);
    assert.ok(watchdogMs('x'.repeat(10_000)) <= 20_000);
  });

  it('clear stops speech and empties the queue', () => {
    const h = harness();
    h.announcer.announce(msg('a', 2));
    h.announcer.announce(msg('b', 2));
    h.announcer.clear();
    assert.deepEqual(h.log, ['speak:a', 'stop']);
    assert.equal(h.announcer.speaking, null);
    assert.deepEqual(h.announcer.queued, []);
    h.finish();
    assert.deepEqual(h.log, ['speak:a', 'stop']);
  });

  it('keeps the last utterance and can repeat it', () => {
    const h = harness();
    assert.equal(h.announcer.repeat(), false);
    h.announcer.announce(msg('found', 1, { text: 'I found a chair.', dedupeMs: 20_000 }));
    h.finish();
    assert.equal(h.announcer.lastUtterance?.text, 'I found a chair.');
    assert.equal(h.announcer.repeat(), true, 'a repeat ignores the dedupe window');
    assert.deepEqual(h.log, ['speak:I found a chair.', 'speak:I found a chair.']);
  });
});

describe('channels and speech start', () => {
  function channelHarness() {
    let time = 0;
    const log: string[] = [];
    const started: [string, number][] = [];
    let pending: SpeakCallbacks | null = null;
    const speaker: Speaker = {
      speak(text, _lang, callbacks) {
        log.push(`speak:${text}`);
        pending = callbacks;
      },
      stop() {
        log.push('stop');
        const callbacks = pending;
        pending = null;
        callbacks?.onStopped();
      },
    };
    const announcer = createAnnouncer(speaker, {
      now: () => time,
      onSpeechStart: (a, at) => started.push([a.key, at]),
      setTimer: () => null,
      clearTimer: () => {},
    });
    return {
      announcer,
      log,
      started,
      startAudio(at: number) {
        time = at;
        pending?.onStart?.();
      },
      finish() {
        const callbacks = pending;
        pending = null;
        callbacks?.onDone();
      },
    };
  }
  const line = (key: string, channel?: Announcement['channel'], priority: Priority = 2): Announcement => ({
    key,
    priority,
    text: key,
    lang: 'en-US',
    ttlMs: 10_000,
    dedupeMs: 0,
    goalId: null,
    ...(channel ? { channel } : {}),
  });

  it('clearChannel drops queued and current lines of that channel only', () => {
    const h = channelHarness();
    h.announcer.announce(line('camera-1', 'camera'));
    h.announcer.announce(line('search-1'));
    h.announcer.announce(line('camera-2', 'camera'));
    h.announcer.clearChannel('camera');
    assert.deepEqual(h.log, ['speak:camera-1', 'stop', 'speak:search-1']);
    assert.deepEqual(h.announcer.queued, []);
    assert.equal(h.announcer.speaking?.key, 'search-1');
  });

  it('clearChannel leaves other speech playing', () => {
    const h = channelHarness();
    h.announcer.announce(line('reply', 'reply', 0));
    h.announcer.announce(line('camera', 'camera'));
    h.announcer.clearChannel('camera');
    assert.deepEqual(h.log, ['speak:reply']);
    h.finish();
    assert.deepEqual(h.log, ['speak:reply']);
  });

  it('reports when the speaker starts each line, and keeps the channel', () => {
    const h = channelHarness();
    h.announcer.announce(line('camera-1', 'camera'));
    h.startAudio(120);
    assert.deepEqual(h.started, [['camera-1', 120]]);
    assert.equal(h.announcer.speaking?.channel, 'camera');
  });

  it('repeats a camera line as a reply, so pausing updates does not cut it', () => {
    const h = channelHarness();
    h.announcer.announce(line('camera-1', 'camera'));
    h.finish();
    h.announcer.repeat();
    assert.equal(h.announcer.speaking?.channel, 'reply');
    h.announcer.clearChannel('camera');
    assert.equal(h.announcer.speaking?.channel, 'reply');
  });
});
