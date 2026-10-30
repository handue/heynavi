/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEARCH, initialSearchState, reduce, sizeHint, type SearchEvent } from './search-machine.ts';
import { det, frame, goal } from './test-helpers.ts';
import type { AnnounceEffect, Detection, Effect, SearchState } from './types.ts';

const G = goal('g1');

/** Small driver: feeds events at given times and keeps the latest state and effects. */
function machine(initial: SearchState = initialSearchState()) {
  let state = initial;
  let frameId = 0;
  const m = {
    get state() {
      return state;
    },
    send(event: SearchEvent, now: number): Effect[] {
      const t = reduce(state, event, now);
      state = t.state;
      return t.effects;
    },
    start(now = 0, g = G) {
      return m.send({ type: 'start', goal: g }, now);
    },
    frame(now: number, detections: Detection[], goalId = G.id) {
      return m.send({ type: 'frame', result: frame(goalId, frameId++, detections, now) }, now);
    },
    tick(now: number) {
      return m.send({ type: 'tick' }, now);
    },
  };
  return m;
}

const announcements = (effects: Effect[]) =>
  effects.filter((e): e is AnnounceEffect => e.type === 'announce');
const texts = (effects: Effect[]) => announcements(effects).map((e) => e.text);
const haptics = (effects: Effect[]) =>
  effects.flatMap((e) => (e.type === 'haptic' ? [e.kind] : []));

/** Runs start + two agreeing frames, so the machine is FOUND at t=2000 (chair on the left). */
function found(m = machine()) {
  m.start(0);
  m.frame(1000, [det(0.2, 0.6)]);
  const effects = m.frame(2000, [det(0.25, 0.7)]);
  assert.equal(m.state.status, 'FOUND');
  return { m, effects };
}

describe('start', () => {
  it('goes to SEARCHING and replies at priority 0, tagged with the goal', () => {
    const m = machine();
    const effects = m.start(0);
    assert.equal(m.state.status, 'SEARCHING');
    assert.equal(m.state.goal, G);
    assert.deepEqual(announcements(effects), [
      {
        type: 'announce',
        key: 'start:g1',
        priority: 0,
        text: 'Looking for a chair. Move your phone slowly.',
        lang: 'en-US',
        ttlMs: SEARCH.ttlMs.reply,
        dedupeMs: 0,
        goalId: 'g1',
      },
    ]);
  });
});

describe('confirmation', () => {
  it('SEARCHING -> CONFIRMING -> FOUND on 2 of 3 frames, with announcement and haptic', () => {
    const m = machine();
    m.start(0);
    assert.deepEqual(m.frame(1000, [det(0.2, 0.6)]), []);
    assert.equal(m.state.status, 'CONFIRMING');
    assert.deepEqual(m.frame(2000, []), []);
    assert.equal(m.state.status, 'CONFIRMING');
    const effects = m.frame(3000, [det(0.25, 0.7)]);
    assert.equal(m.state.status, 'FOUND');
    assert.deepEqual(texts(effects), ['I found a chair, on the left of the camera view.']);
    const [announce] = announcements(effects);
    assert.equal(announce.priority, 1);
    assert.equal(announce.key, 'found:g1:0:left');
    assert.equal(announce.dedupeMs, SEARCH.dedupeMs.found);
    assert.deepEqual(haptics(effects), ['found']);

    // FOUND is transient: the next frame is guiding.
    assert.deepEqual(m.frame(4000, [det(0.25, 0.7)]), []);
    assert.equal(m.state.status, 'GUIDING');
  });

  it('CONFIRMING -> SEARCHING after 2 consecutive misses', () => {
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.5, 0.6)]);
    m.frame(2000, []);
    assert.equal(m.state.status, 'CONFIRMING');
    m.frame(3000, []);
    assert.equal(m.state.status, 'SEARCHING');
  });

  it('never confirms candidates below tau_confirm, nor null confidences', () => {
    const m = machine();
    m.start(0);
    for (let t = 1000; t <= 6000; t += 1000) {
      assert.deepEqual(haptics(m.frame(t, [det(0.5, 0.45), det(0.5, null)])), []);
    }
    assert.equal(m.state.status, 'CONFIRMING');
  });

  it('does not confirm when the frames disagree on position', () => {
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.1, 0.9)]);
    m.frame(2000, [det(0.9, 0.9)]);
    assert.equal(m.state.status, 'CONFIRMING');
  });

  it('reports several confident instances by the largest one', () => {
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.2, 0.8, 0.05), det(0.5, 0.7, 0.2)]);
    const effects = m.frame(2000, [det(0.2, 0.8, 0.05), det(0.5, 0.7, 0.2)]);
    assert.deepEqual(texts(effects), ['I see 2 chairs. The largest is in the center.']);
    assert.equal(m.state.trackX, 0.5);
    assert.equal(m.state.position, 'center');
  });

  it('adds a size phrase from box area only', () => {
    assert.equal(sizeHint(0.26), 'close');
    assert.equal(sizeHint(0.25), null);
    assert.equal(sizeHint(0.029), 'far');
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.8, 0.9, 0.4)]);
    assert.deepEqual(texts(m.frame(2000, [det(0.8, 0.9, 0.4)])), [
      'I found a chair, on the right of the camera view. It looks close.',
    ]);
  });
});

describe('stale results', () => {
  it('ignores frames tagged with another goal', () => {
    const m = machine();
    m.start(0);
    const before = m.state;
    assert.deepEqual(m.frame(1000, [det(0.5, 0.9)], 'old-goal'), []);
    assert.equal(m.state, before);
  });

  it('a new goal drops the old evidence and old results', () => {
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.5, 0.9)]);
    m.start(1500, goal('g2', 'cup'));
    assert.equal(m.state.status, 'SEARCHING');
    assert.deepEqual(m.state.window, []);
    m.frame(2000, [det(0.5, 0.9)], 'g1');
    assert.equal(m.state.status, 'SEARCHING', 'g1 result ignored');
  });

  it('ignores frames while paused or after stop', () => {
    const m = machine();
    m.start(0);
    m.send({ type: 'pause' }, 500);
    assert.deepEqual(m.frame(1000, [det(0.5, 0.9)]), []);
    assert.equal(m.state.status, 'PAUSED');
    m.send({ type: 'stop' }, 1500);
    assert.deepEqual(m.frame(2000, [det(0.5, 0.9)]), []);
    assert.equal(m.state.status, 'CANCELLED');
  });
});

describe('guiding', () => {
  it('speaks position changes at most once per 2.5 s, and the centered haptic once on entering center', () => {
    const { m } = found(); // left, spoken at t=2000
    let effects = m.frame(3000, [det(0.5, 0.7)]);
    assert.deepEqual(haptics(effects), ['centered']);
    assert.deepEqual(texts(effects), [], 'rate limited: 1 s since the found announcement');

    effects = m.frame(4000, [det(0.5, 0.7)]);
    assert.deepEqual(haptics(effects), [], 'still centered: no second haptic');
    assert.deepEqual(texts(effects), []);

    effects = m.frame(4500, [det(0.5, 0.7)]);
    assert.deepEqual(texts(effects), ['Centered.']);
    assert.equal(announcements(effects)[0].priority, 2);

    assert.deepEqual(texts(m.frame(5000, [det(0.9, 0.7)])), [], '0.5 s after the last update');
    assert.deepEqual(texts(m.frame(6000, [det(0.85, 0.7)])), []);
    assert.deepEqual(texts(m.frame(7000, [det(0.85, 0.7)])), ['Now on the right.']);
    assert.deepEqual(texts(m.frame(8000, [det(0.85, 0.7)])), [], 'same bucket: nothing to say');
  });

  it('follows the tracked instance rather than the most confident one', () => {
    const { m } = found(); // tracking x=0.25
    m.frame(3000, [det(0.9, 0.95), det(0.28, 0.5)]);
    assert.equal(m.state.trackX, 0.28);
    assert.equal(m.state.position, 'left');
  });

  it('GUIDING -> LOST after 3 consecutive misses, then SEARCHING with the same goal', () => {
    const { m } = found();
    assert.deepEqual(m.frame(3000, []), []);
    assert.deepEqual(m.frame(4000, []), []);
    assert.equal(m.state.status, 'GUIDING');
    const effects = m.frame(5000, []);
    assert.equal(m.state.status, 'LOST');
    assert.deepEqual(texts(effects), ['I lost sight of the chair. Still looking.']);
    assert.equal(announcements(effects)[0].priority, 1);

    m.frame(6000, []);
    assert.equal(m.state.status, 'SEARCHING');
    assert.equal(m.state.goal, G);
    m.frame(7000, [det(0.5, 0.9)]);
    assert.equal(m.state.status, 'CONFIRMING');
  });

  it('a re-find after "lost" gets a new dedupe key, and so does the next loss', () => {
    const { m, effects: first } = found(); // found:g1:0:left
    m.frame(3000, []);
    m.frame(4000, []);
    const lost = announcements(m.frame(5000, []))[0];
    assert.equal(lost.key, 'lost:g1:0');
    m.frame(6000, [det(0.2, 0.6)]);
    const again = announcements(m.frame(7000, [det(0.25, 0.7)]))[0];
    assert.equal(m.state.status, 'FOUND');
    assert.equal(again.text, announcements(first)[0].text);
    assert.equal(again.key, 'found:g1:1:left');
    m.frame(8000, []);
    m.frame(9000, []);
    assert.equal(announcements(m.frame(10_000, []))[0].key, 'lost:g1:1');
  });

  it('a hit between misses resets the lost counter', () => {
    const { m } = found();
    m.frame(3000, []);
    m.frame(4000, []);
    m.frame(5000, [det(0.3, 0.6)]);
    m.frame(6000, []);
    m.frame(7000, []);
    assert.equal(m.state.status, 'GUIDING');
  });
});

describe('coaching', () => {
  it('prompts at 10 s, every 15 s, with one check-in at 60 s', () => {
    const m = machine();
    m.start(0);
    const spoken: [number, string][] = [];
    for (let t = 0; t <= 91_000; t += 500) {
      for (const text of texts(m.tick(t))) spoken.push([t, text]);
    }
    assert.deepEqual(
      spoken.map(([t]) => t),
      [10_000, 25_000, 40_000, 60_000, 75_000, 90_000],
    );
    assert.equal(spoken[0][1], 'Still looking for a chair. Try turning slowly.');
    assert.equal(spoken[1][1], 'Still looking for a chair. Try tilting the phone up or down a little.');
    assert.match(spoken[3][1], /^I haven't found a chair in the last minute\./);
    assert.match(spoken[4][1], /^Still looking for a chair\./);
  });

  it('counts from the last confirm-strength candidate, and stays quiet while it is being confirmed or guided', () => {
    const m = machine();
    m.start(0);
    m.frame(8000, [det(0.5, 0.6)]); // strong candidate, not yet confirmed: CONFIRMING
    assert.deepEqual(m.tick(10_000), [], 'no coaching right after a strong candidate');
    m.frame(9000, []);
    m.frame(10_000, []);
    assert.equal(m.state.status, 'SEARCHING');
    assert.deepEqual(m.tick(17_500), []);
    assert.equal(texts(m.tick(18_000)).length, 1, '10 s after the last candidate');

    const { m: guiding } = found();
    for (let t = 2500; t <= 30_000; t += 500) {
      if (t % 1000 === 0) guiding.frame(t, [det(0.25, 0.7)]);
      assert.deepEqual(texts(guiding.tick(t)), []);
    }
  });

  it('keeps coaching while a weak candidate never confirms', () => {
    const m = machine();
    m.start(0);
    const spoken: number[] = [];
    for (let t = 500; t <= 120_000; t += 500) {
      if (t % 1000 === 0) m.frame(t, [det(0.5, 0.45)]); // between tau_detect and tau_confirm
      if (texts(m.tick(t)).length > 0) spoken.push(t);
    }
    assert.equal(m.state.status, 'CONFIRMING');
    assert.deepEqual(spoken, [10_000, 25_000, 40_000, 60_000, 75_000, 90_000, 105_000, 120_000]);
  });

  it('is silent while frames fail, and the outage does not count as searching time', () => {
    const m = machine();
    m.start(0);
    assert.deepEqual(m.send({ type: 'outage' }, 5000), []);
    assert.equal(m.state.outageSince, 5000);
    m.send({ type: 'outage' }, 6000);
    assert.equal(m.state.outageSince, 5000, 'the outage starts at the first failure');
    for (let t = 5000; t <= 70_000; t += 500) assert.deepEqual(m.tick(t), [], `t=${t}`);

    m.send({ type: 'recovered' }, 70_000); // 65 s outage
    assert.equal(m.state.outageSince, null);
    assert.equal(m.state.nextCoachingAt, 75_000, 'the first prompt keeps its 5 s left');
    const spoken: [number, string][] = [];
    for (let t = 70_500; t <= 125_000; t += 500) {
      for (const text of texts(m.tick(t))) spoken.push([t, text]);
    }
    // The check-in still means one minute of actual searching: 0-5 s plus 70-125 s.
    assert.deepEqual(
      spoken.map(([t]) => t),
      [75_000, 90_000, 105_000, 125_000],
    );
    assert.equal(spoken[0][1], 'Still looking for a chair. Try turning slowly.');
    assert.match(spoken[3][1], /^I haven't found a chair in the last minute\./);
  });

  it('drops evidence from before an outage, so a stale frame cannot confirm', () => {
    const m = machine();
    m.start(0);
    m.frame(1000, [det(0.2, 0.9)]);
    assert.equal(m.state.status, 'CONFIRMING');
    m.send({ type: 'outage' }, 2000);
    m.send({ type: 'recovered' }, 30_000);
    assert.equal(m.state.status, 'SEARCHING');
    assert.deepEqual(m.state.window, []);

    // Without the pre-outage frame, one fresh hit is only a candidate again...
    assert.deepEqual(texts(m.frame(31_000, [det(0.2, 0.9)])), []);
    assert.equal(m.state.status, 'CONFIRMING');
    // ...and a second fresh hit confirms.
    assert.match(texts(m.frame(32_000, [det(0.2, 0.9)])).join(' '), /^I found a chair/);
  });

  it('ignores outage events when not searching', () => {
    const m = machine();
    assert.deepEqual(m.send({ type: 'outage' }, 0), []);
    assert.equal(m.state.outageSince, null);
    assert.deepEqual(m.send({ type: 'recovered' }, 10), []);
  });

  it('uses one dedupe key per prompt', () => {
    const m = machine();
    m.start(0);
    const first = announcements(m.tick(10_000))[0];
    const second = announcements(m.tick(25_000))[0];
    assert.notEqual(first.key, second.key);
    assert.equal(first.goalId, 'g1');
  });
});

describe('pause, resume, stop', () => {
  it('pause keeps the goal; resume searches again and says so', () => {
    const { m } = found();
    assert.deepEqual(m.send({ type: 'pause' }, 3000), []);
    assert.equal(m.state.status, 'PAUSED');
    assert.equal(m.state.goal, G);
    const effects = m.send({ type: 'resume' }, 50_000);
    assert.equal(m.state.status, 'SEARCHING');
    assert.equal(m.state.goal, G);
    assert.deepEqual(texts(effects), ['Looking for a chair again.']);
    assert.equal(m.state.episode, 1, 'a re-find after resuming is spoken again');
    // Coaching counts from the resume, not from the original start.
    assert.deepEqual(m.tick(59_500), []);
    assert.equal(texts(m.tick(60_000)).length, 1);
  });

  it('resume without a pause does nothing', () => {
    const m = machine();
    m.start(0);
    assert.deepEqual(m.send({ type: 'resume' }, 100), []);
    assert.equal(m.state.status, 'SEARCHING');
  });

  it('stop cancels, clears the goal and replies with an announcement not tied to the goal', () => {
    const { m } = found();
    const effects = m.send({ type: 'stop' }, 3000);
    assert.equal(m.state.status, 'CANCELLED');
    assert.equal(m.state.goal, null);
    assert.deepEqual(announcements(effects).map((a) => [a.text, a.priority, a.goalId]), [
      ['Stopped searching.', 0, null],
    ]);
    assert.deepEqual(m.send({ type: 'stop' }, 3100), [], 'already stopped');
    assert.deepEqual(m.tick(20_000), []);
  });
});
