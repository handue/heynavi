/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ATTENTION, INITIAL_POLICY, decide, rank, type PolicyState } from './attention-policy.ts';
import { EMPTY_MEMORY, markSpoken, mergeReply, type SceneMemory } from './scene-memory.ts';
import { sceneItem } from './scene-test-helpers.ts';
import type { SceneChange, SceneItem, Verbosity } from './types.ts';

/** Runs replies through memory and the policy the way the scene controller does. */
function session(verbosity: Verbosity = 'normal') {
  let memory: SceneMemory = EMPTY_MEMORY;
  let state: PolicyState = INITIAL_POLICY;
  return {
    reply(now: number, items: SceneItem[], summary: string | null = null, change: SceneChange = 'minor', describe = false) {
      const merged = mergeReply(memory, { summary, items }, now);
      const decision = decide({ reply: { summary, change }, merged, verbosity, state, now, describe });
      memory = markSpoken(merged.memory, decision.spokenKeys, now);
      state = decision.state;
      return decision;
    },
    get memory() {
      return memory;
    },
  };
}

describe('first look', () => {
  it('speaks the summary first, and marks the items it names as spoken', () => {
    const s = session();
    const d = s.reply(0, [sceneItem('door', { kind: 'landmark', position: 'right' })], 'A hallway with a door on the right', 'major');
    assert.equal(d.note, 'first-look');
    assert.equal(d.announcement?.text, 'A hallway with a door on the right.');
    assert.equal(d.announcement?.channel, 'camera');
    assert.deepEqual(d.spokenKeys, ['door']);
  });

  it('falls back to the top items when the summary was filtered', () => {
    const d = session().reply(0, [sceneItem('chair', { band: 'lower', importance: 'high' }), sceneItem('lamp', { importance: 'low' })]);
    assert.equal(d.announcement?.text, 'I see a chair in the lower center of the camera view, and a lamp in the center of the camera view.');
  });

  it('says nothing when nothing is in view, and does not try again', () => {
    const s = session();
    assert.equal(s.reply(0, []).announcement, null);
    assert.equal(s.reply(7000, [sceneItem('chair')]).note, 'item');
  });
});

describe('proactive lines', () => {
  it('mentions a new item once, then not again within its window', () => {
    const s = session();
    s.reply(0, [], 'An office', 'major');
    const d = s.reply(7000, [sceneItem('person', { kind: 'person', position: 'left' })]);
    assert.equal(d.announcement?.text, 'I see a person on the left of the camera view.');
    assert.equal(d.announcement?.key, 'scene:item:person');
    assert.equal(d.announcement?.dedupeMs, ATTENTION.dedupeMs.item);
    assert.equal(s.reply(14_000, [sceneItem('person', { kind: 'person', status: 'still' })]).note, 'nothing-new');
    assert.equal(s.reply(21_000, [sceneItem('person', { kind: 'person', status: 'new' })]).note, 'nothing-new');
    // After its window it may be mentioned again if Spark calls it new.
    assert.equal(s.reply(70_000, [sceneItem('person', { kind: 'person', status: 'new' })]).note, 'item');
  });

  it('keeps lines apart and caps them per minute', () => {
    const s = session();
    s.reply(0, [], 'A room', 'major');
    assert.equal(s.reply(3000, [sceneItem('chair')]).note, 'gap');
    // Still recent and never spoken, so it gets its chance once the gap has passed.
    assert.equal(s.reply(6500, [sceneItem('chair', { status: 'still' })]).note, 'item');
    const labels = ['table', 'lamp', 'sofa', 'plant', 'box', 'rug'];
    const notes = labels.map((label, i) => s.reply(13_000 + i * 7000, [sceneItem(label)]).note);
    // 6 per minute: the first look and the chair already count.
    assert.deepEqual(notes.slice(0, 4), ['item', 'item', 'item', 'item']);
    assert.ok(notes.includes('rate'));
  });

  it('picks the most important item, preferring things low and central', () => {
    const s = session();
    s.reply(0, [], 'A room', 'major');
    const d = s.reply(7000, [
      sceneItem('picture', { importance: 'low', band: 'upper' }),
      sceneItem('table', { importance: 'medium' }),
      sceneItem('box', { kind: 'possible_obstacle', importance: 'high', band: 'lower' }),
    ]);
    assert.equal(d.announcement?.text, 'I see a box in the lower center of the camera view.');
    assert.equal(d.announcement?.priority, 2);
    assert.doesNotMatch(d.announcement?.text ?? '', /obstacle/i, 'no obstacle wording before SAM checks it (M4)');
  });

  it('follows verbosity', () => {
    const quiet = session('quiet');
    quiet.reply(0, [], 'A room', 'major');
    assert.equal(quiet.reply(7000, [sceneItem('table')]).note, 'nothing-new');
    assert.equal(quiet.reply(14_000, [sceneItem('person', { importance: 'high', kind: 'person' })]).note, 'item');
    assert.equal(quiet.reply(21_000, [], 'A kitchen', 'major').note, 'nothing-new', 'no summaries when quiet');

    const normal = session('normal');
    normal.reply(0, [], 'A room', 'major');
    assert.equal(normal.reply(7000, [sceneItem('lamp', { importance: 'low' })]).note, 'nothing-new');

    const detailed = session('detailed');
    detailed.reply(0, [], 'A room', 'major');
    const d = detailed.reply(7000, [sceneItem('lamp', { importance: 'low' })]);
    assert.equal(d.announcement?.priority, 3);
    assert.equal(d.announcement?.dedupeMs, ATTENTION.dedupeMs.low);
  });

  it('speaks a major change as its summary, adding an important item it leaves out', () => {
    const s = session();
    s.reply(0, [], 'A hallway', 'major');
    const d = s.reply(25_000, [sceneItem('table'), sceneItem('person', { kind: 'person', importance: 'high', position: 'right' })], 'A kitchen with a table', 'major');
    assert.equal(d.note, 'summary');
    assert.equal(d.announcement?.text, 'A kitchen with a table. I see a person on the right of the camera view.');
    assert.deepEqual(d.spokenKeys.sort(), ['person', 'table']);
    // The next summary waits for its own window.
    assert.equal(s.reply(33_000, [], 'A pantry', 'major').note, 'nothing-new');
  });

  it('reads text when it passes the filters, and never speaks a command or the wake word', () => {
    const s = session();
    s.reply(0, [], 'A corridor', 'major');
    const sign = s.reply(7000, [sceneItem('sign', { kind: 'text', text: 'Exit', ground: null, band: 'upper' })]);
    assert.equal(sign.announcement?.text, 'I see a sign in the upper center of the camera view. It reads: Exit.');
    assert.equal(sign.announcement?.priority, 3);
    const stop = s.reply(14_000, [sceneItem('poster', { kind: 'text', text: 'Stop', ground: null })]);
    assert.equal(stop.announcement?.text, 'I see a poster in the center of the camera view with some text on it.');
  });

  it('drops a summary that breaks the wording rules', () => {
    const d = session().reply(0, [sceneItem('door')], 'The path ahead is clear', 'major');
    assert.equal(d.announcement?.text, 'I see a door in the center of the camera view.');
  });
});

describe('describe on request', () => {
  it('answers with the summary plus items it does not name, as a reply', () => {
    const s = session();
    s.reply(0, [], 'A room', 'major');
    const d = s.reply(
      2000,
      [sceneItem('door', { kind: 'landmark', position: 'right' }), sceneItem('chair', { band: 'lower' }), sceneItem('cat', { count: 2, position: 'left' })],
      'A living room with a door on the right',
      'none',
      true,
    );
    assert.equal(d.note, 'describe');
    assert.equal(d.announcement?.priority, 0);
    assert.equal(d.announcement?.channel, 'reply');
    assert.equal(
      d.announcement?.text,
      'A living room with a door on the right. I see a chair in the lower center of the camera view, and 2 cats on the left of the camera view.',
    );
    assert.deepEqual(d.spokenKeys.sort(), ['cat', 'chair', 'door']);
  });

  it('says so when there is nothing to describe', () => {
    const d = session().reply(0, [], null, 'none', true);
    assert.equal(d.announcement?.text, "I can't make out anything to describe right now.");
  });
});

describe('rank', () => {
  it('orders by importance, kind, band and position', () => {
    const { reported } = mergeReply(
      EMPTY_MEMORY,
      {
        summary: null,
        items: [
          sceneItem('lamp', { importance: 'low' }),
          sceneItem('table'),
          sceneItem('door', { kind: 'landmark' }),
          sceneItem('box', { kind: 'possible_obstacle', importance: 'high' }),
          sceneItem('bag', { kind: 'possible_obstacle', importance: 'high', band: 'lower', position: 'left' }),
        ],
      },
      0,
    );
    assert.deepEqual(rank(reported).map((i) => i.key), ['bag', 'box', 'door', 'table', 'lamp']);
  });
});
