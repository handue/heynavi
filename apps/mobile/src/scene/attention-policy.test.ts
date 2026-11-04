/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ATTENTION, INITIAL_POLICY, decide, isHazard, lineMarks, mention, rank, unmarkLine, type PolicyState } from './attention-policy.ts';
import { EMPTY_MEMORY, markSpoken, mergeReply, spokenBefore, unmarkSpoken, type SceneMemory } from './scene-memory.ts';
import { sceneItem } from './scene-test-helpers.ts';
import type { HoldFrame, SceneChange, SceneItem, Verbosity } from './types.ts';

/** Runs replies through memory and the policy the way the scene controller does. */
function session(verbosity: Verbosity = 'normal', frame: HoldFrame = 'camera') {
  let memory: SceneMemory = EMPTY_MEMORY;
  let state: PolicyState = INITIAL_POLICY;
  return {
    reply(now: number, items: SceneItem[], summary: string | null = null, change: SceneChange = 'minor', describe = false) {
      const merged = mergeReply(memory, { summary, items }, now);
      const decision = decide({ reply: { summary, change }, merged, verbosity, state, now, describe, frame });
      memory = markSpoken(merged.memory, decision.spokenKeys, now);
      state = decision.state;
      return decision;
    },
    /** A first look already happened, so the next reply is judged on its items. */
    started(now = 0) {
      this.reply(now, [], 'A room', 'major');
      return this;
    },
  };
}

// Builders for the walking scenes. sceneItem() defaults: kind "object", importance "medium",
// confirmed by SAM.
const onFloor = (label: string, o: Partial<SceneItem> = {}) =>
  sceneItem(label, { kind: 'possible_obstacle', importance: 'high', band: 'lower', ...o });
const decor = (label: string, o: Partial<SceneItem> = {}) =>
  sceneItem(label, { kind: 'object', importance: 'low', band: 'upper', ...o });
const person = (o: Partial<SceneItem> = {}) => sceneItem('person', { kind: 'person', importance: 'high', ...o });
const steps = (o: Partial<SceneItem> = {}) =>
  sceneItem('steps', { kind: 'level_change', importance: 'high', band: 'lower', ...o });

function onFloorMemory(o: Partial<SceneItem>) {
  return mergeReply(EMPTY_MEMORY, { summary: null, items: [onFloor('bag', o)] }, 0).reported[0];
}

describe('walking relevance (after round 3)', () => {
  it('suppresses decor and desk objects, and announces the bag on the floor', () => {
    const s = session('normal', 'forward').started();
    const d = s.reply(7000, [
      decor('picture'),
      decor('television', { position: 'right', importance: 'medium', band: 'middle' }),
      sceneItem('laptop', { importance: 'low' }),
      onFloor('bag'),
    ]);
    assert.equal(d.announcement?.text, 'Possible obstacle: a bag directly ahead.');
    assert.deepEqual(d.spokenKeys, ['bag']);
  });

  it('says nothing when only irrelevant things are in view, and never that the way is clear', () => {
    const s = session('detailed').started();
    const d = s.reply(7000, [decor('picture'), sceneItem('monitor', { importance: 'medium' }), decor('lamp')]);
    assert.equal(d.note, 'nothing-new');
    assert.equal(d.announcement, null);
  });

  it('puts hazards first, at priority 1, before people and doors', () => {
    const s = session('normal', 'forward').started();
    const d = s.reply(7000, [
      sceneItem('door', { kind: 'landmark', importance: 'medium', position: 'right' }),
      person({ position: 'right', importance: 'medium' }),
      onFloor('chair', { position: 'left', band: 'middle' }),
    ]);
    assert.equal(d.announcement?.priority, 1);
    assert.equal(
      d.announcement?.text,
      'Possible obstacle: a chair ahead on your left. A person is visible ahead on your right.',
    );
  });

  it('says level changes plainly, as hazards', () => {
    const d = session('normal', 'forward').started().reply(7000, [steps()]);
    assert.equal(d.announcement?.text, 'Steps are visible ahead.');
    assert.equal(d.announcement?.priority, 1);
  });

  it('mentions something off to the side as visible, not as an obstacle', () => {
    const d = session('normal', 'forward').started().reply(7000, [onFloor('bag', { importance: 'medium', position: 'right' })]);
    assert.equal(d.announcement?.text, 'A bag is visible on the floor ahead on your right.');
    assert.equal(d.announcement?.priority, 2);
  });

  it('does not count clothing', () => {
    const d = session('normal', 'forward').started().reply(7000, [onFloor('clothing', { count: 3 })]);
    assert.equal(d.announcement?.text, 'Possible obstacle: some clothing directly ahead.');
  });
});

describe('uncertain observations and SAM misses', () => {
  it('hedges a hazard SAM could not find: a miss is not proof it is absent', () => {
    const d = session('normal', 'forward').started().reply(7000, [onFloor('bag', { grounded: false })]);
    assert.equal(d.announcement?.text, 'There may be a bag on the floor ahead.');
    assert.equal(d.announcement?.priority, 2, 'not a confirmed hazard');
    assert.equal(isHazard(onFloorMemory({ grounded: false })), false);
  });

  it('hedges a hazard SAM did not check, and a level change with no concept', () => {
    const s = session('normal', 'forward').started();
    assert.equal(s.reply(7000, [steps({ grounded: null, ground: null })]).announcement?.text, 'There may be steps ahead.');
    assert.equal(
      s.reply(14_000, [onFloor('cable', { grounded: null, position: 'left' })]).announcement?.text,
      'There may be a cable on the floor ahead on your left.',
    );
  });

  it('stays silent about unconfirmed things off to the side, unconfirmed doors and decor', () => {
    const s = session('normal').started();
    assert.equal(s.reply(7000, [onFloor('box', { grounded: false, importance: 'medium' })]).note, 'nothing-new');
    assert.equal(s.reply(14_000, [sceneItem('door', { kind: 'landmark', grounded: false, importance: 'high' })]).note, 'nothing-new');
    assert.equal(s.reply(21_000, [decor('poster', { grounded: null })]).note, 'nothing-new');
  });

  it('a confirmed hazard may follow sooner than other lines; a hedged one waits', () => {
    const s = session().started();
    assert.equal(s.reply(3500, [onFloor('bag', { grounded: false })]).note, 'gap');
    assert.equal(s.reply(3600, [onFloor('box')]).announcement?.priority, 1);
  });
});

describe('mention', () => {
  it('follows verbosity', () => {
    const side = { kind: 'possible_obstacle' as const, grounded: true, band: 'lower' as const, importance: 'medium' as const };
    assert.equal(mention(side, 'quiet'), null);
    assert.equal(mention(side, 'normal'), 'visible');
    assert.equal(mention({ ...side, importance: 'high' }, 'quiet'), 'obstacle');
    const sign = { kind: 'text' as const, grounded: null, band: 'upper' as const, importance: 'medium' as const };
    assert.equal(mention(sign, 'normal'), null);
    assert.equal(mention(sign, 'detailed'), 'text');
    assert.equal(mention({ ...side, kind: 'object' }, 'detailed'), null, 'plain objects never, even at detailed');
  });

  it('never calls something high in the view an obstacle, except overhead things', () => {
    const high = { kind: 'possible_obstacle' as const, grounded: true, band: 'upper' as const, importance: 'high' as const };
    assert.equal(mention(high, 'normal'), 'visible');
    assert.equal(mention({ ...high, kind: 'overhead' }, 'normal'), 'obstacle');
  });
});

describe('first look', () => {
  it('speaks the summary first, and marks the items it names as spoken', () => {
    const d = session().reply(
      0,
      [sceneItem('door', { kind: 'landmark', position: 'right' })],
      'A hallway with a door on the right',
      'major',
    );
    assert.equal(d.note, 'first-look');
    assert.equal(d.announcement?.text, 'A hallway with a door on the right.');
    assert.equal(d.announcement?.channel, 'camera');
    assert.deepEqual(d.spokenKeys, ['door']);
  });

  it('falls back to confirmed walking-relevant items when the summary was filtered', () => {
    const d = session().reply(0, [decor('picture'), onFloor('chair'), sceneItem('door', { kind: 'landmark', position: 'left' })]);
    assert.equal(
      d.announcement?.text,
      "There's a chair in the lower center of the camera view, and a door on the left of the camera view.",
    );
  });

  it('says nothing when nothing relevant is in view, and does not try again', () => {
    const s = session();
    assert.equal(s.reply(0, [decor('picture')]).announcement, null);
    assert.equal(s.reply(7000, [onFloor('box')]).note, 'item');
  });

  it('drops a summary that breaks the wording rules', () => {
    const d = session().reply(0, [onFloor('box')], 'The path ahead is clear', 'major');
    assert.equal(d.announcement?.text, "There's a box in the lower center of the camera view.");
  });
});

describe('repetition and rate', () => {
  it('mentions a new thing once, then not again within its window', () => {
    const s = session().started();
    assert.equal(s.reply(7000, [person({ position: 'left' })]).announcement?.text, 'A person is visible on the left of the camera view.');
    assert.equal(s.reply(14_000, [person({ status: 'still' })]).note, 'nothing-new');
    assert.equal(s.reply(21_000, [person({ status: 'new' })]).note, 'nothing-new');
    assert.equal(s.reply(70_000, [person({ status: 'new' })]).note, 'item');
  });

  it('keeps lines apart and caps them per minute', () => {
    const s = session().started();
    assert.equal(s.reply(3000, [onFloor('chair', { importance: 'medium' })]).note, 'gap');
    assert.equal(s.reply(6500, [onFloor('chair', { importance: 'medium', status: 'still' })]).note, 'item');
    const labels = ['table', 'stool', 'sofa', 'plant', 'cart', 'rug'];
    const notes = labels.map((label, i) => s.reply(13_000 + i * 7000, [onFloor(label, { importance: 'medium' })]).note);
    assert.deepEqual(notes.slice(0, 4), ['item', 'item', 'item', 'item']);
    assert.ok(notes.includes('rate'));
  });

  it('speaks a major change as its summary, adding an in-path thing it leaves out', () => {
    const s = session().started();
    const d = s.reply(
      25_000,
      [sceneItem('table', { kind: 'possible_obstacle', importance: 'medium' }), person({ position: 'right' })],
      'A kitchen with a table',
      'major',
    );
    assert.equal(d.note, 'summary');
    assert.equal(d.announcement?.text, 'A kitchen with a table. A person is visible on the right of the camera view.');
    assert.deepEqual(d.spokenKeys.sort(), ['person', 'table']);
    assert.equal(s.reply(33_000, [], 'A pantry', 'major').note, 'nothing-new');
  });

  it('never speaks a sign that reads like a command or the wake word', () => {
    const s = session('detailed').started();
    const sign = s.reply(7000, [sceneItem('sign', { kind: 'text', text: 'Exit', ground: null, grounded: null, band: 'upper' })]);
    assert.equal(sign.announcement?.text, 'A sign in the upper center of the camera view. It reads: Exit.');
    const stop = s.reply(14_000, [sceneItem('poster', { kind: 'text', text: 'Stop', ground: null, grounded: null })]);
    assert.equal(stop.announcement?.text, "There's a poster with some text in the center of the camera view.");
  });
});

describe('directions', () => {
  it('relative to the user only when the phone was held forward', () => {
    const forward = session('normal', 'forward').started();
    assert.equal(forward.reply(7000, [person({ position: 'right' })]).announcement?.text, 'A person is visible ahead on your right.');
    assert.equal(forward.reply(14_000, [onFloor('box')]).announcement?.text, 'Possible obstacle: a box directly ahead.');
    const camera = session('normal', 'camera').started();
    assert.equal(
      camera.reply(7000, [onFloor('box', { position: 'left' })]).announcement?.text,
      'Possible obstacle: a box in the lower left of the camera view.',
    );
  });
});

describe('describe on request', () => {
  it('answers with the summary plus items it does not name, as a reply', () => {
    const d = session().started().reply(
      2000,
      [sceneItem('door', { kind: 'landmark', position: 'right' }), onFloor('chair'), sceneItem('cat', { count: 2, position: 'left' })],
      'A living room with a door on the right',
      'none',
      true,
    );
    assert.equal(d.note, 'describe');
    assert.equal(d.announcement?.priority, 0);
    assert.equal(d.announcement?.channel, 'reply');
    assert.equal(
      d.announcement?.text,
      "A living room with a door on the right. There's a chair in the lower center of the camera view, and 2 cats on the left of the camera view.",
    );
  });

  it('says so when there is nothing to describe', () => {
    const d = session().reply(0, [], null, 'none', true);
    assert.equal(d.announcement?.text, "I can't make out anything to describe right now.");
  });
});

describe('rank', () => {
  it('orders by relevance, then walking kind, band and position', () => {
    const { reported } = mergeReply(
      EMPTY_MEMORY,
      {
        summary: null,
        items: [
          decor('lamp'),
          sceneItem('table'),
          sceneItem('door', { kind: 'landmark' }),
          onFloor('box', { band: 'middle' }),
          onFloor('bag', { position: 'left' }),
        ],
      },
      0,
    );
    assert.deepEqual(rank(reported).map((i) => i.key), ['bag', 'box', 'door', 'table', 'lamp']);
    assert.equal(ATTENTION.dedupeMs.item, 60_000);
  });
});

describe('round 4 fixes', () => {
  it('says two confirmed obstacles as one sentence', () => {
    const d = session('normal', 'forward').started().reply(7000, [onFloor('box', { count: 2, position: 'left' }), onFloor('shoe', { count: 9 })]);
    // Ranked: the shoes are in the center, so they come first.
    assert.equal(d.announcement?.text, 'Possible obstacles: 9 shoes directly ahead, and 2 boxes ahead on your left.');
    assert.equal(d.announcement?.key, 'scene:item:shoe+box');
  });

  it('does not repeat a thing that left memory and came back within its window', () => {
    const s = session().started();
    assert.equal(s.reply(7000, [onFloor('box')]).note, 'item');
    // Unseen for 35 s: memory forgets it, but it was spoken 35 s ago, inside the 60 s window.
    assert.equal(s.reply(42_000, [onFloor('box')]).note, 'nothing-new');
    // A different thing in the same reply is still said.
    assert.equal(s.reply(49_000, [onFloor('box'), onFloor('basket')]).announcement?.text, 'Possible obstacle: a basket in the lower center of the camera view.');
    assert.equal(s.reply(80_000, [onFloor('box', { status: 'new' })]).note, 'item', 'after the window');
  });
});

describe('a line that expires unheard (walk of 2026-11-03)', () => {
  const at = 10_000;
  const before: PolicyState = { firstLookDone: true, spokenAt: [1000], summarySpokenAt: null, spokenKeys: { door: 1000 } };

  function curbLine() {
    const merged = mergeReply(EMPTY_MEMORY, { summary: null, items: [steps({ label: 'curb', ground: 'curb' })] }, at);
    const decision = decide({ reply: { summary: null, change: 'minor' }, merged, verbosity: 'normal', state: before, now: at });
    return { merged, decision };
  }

  it('undoes exactly what the line marked, so the next look can say it', () => {
    const { merged, decision } = curbLine();
    assert.equal(decision.note, 'item');
    assert.deepEqual(unmarkLine(decision.state, lineMarks(before, decision, at)), before);

    const memory = markSpoken(merged.memory, decision.spokenKeys, at);
    const undone = unmarkSpoken(memory, spokenBefore(merged.memory, decision.spokenKeys), at, 14_000);
    const curb = undone.items.find((i) => i.key === 'curb');
    assert.equal(curb?.lastSpokenAt, null);
    assert.equal(curb?.firstSeenAt, 14_000, 'recently appeared again, from the drop');
  });

  it('keeps what a later line marked', () => {
    const { decision } = curbLine();
    const later: PolicyState = {
      ...decision.state,
      spokenAt: [...decision.state.spokenAt, 15_000],
      spokenKeys: { ...decision.state.spokenKeys, curb: 15_000 },
    };
    const kept = unmarkLine(later, lineMarks(before, decision, at));
    assert.deepEqual(kept.spokenAt, [1000, 15_000]);
    assert.equal(kept.spokenKeys.curb, 15_000);
    assert.equal(kept.spokenKeys.door, 1000);
  });

  it('keeps an unheard first look done, but frees its summary and its place in the rate', () => {
    // Redoing the first look would speak only the summary on the next reply and push a hazard to
    // a later look (review of the fix).
    const merged = mergeReply(EMPTY_MEMORY, { summary: 'A sidewalk', items: [] }, 5000);
    const first = decide({ reply: { summary: 'A sidewalk', change: 'major' }, merged, verbosity: 'normal', state: INITIAL_POLICY, now: 5000 });
    assert.equal(first.note, 'first-look');
    const undone = unmarkLine(first.state, lineMarks(INITIAL_POLICY, first, 5000));
    assert.deepEqual(undone, { ...INITIAL_POLICY, firstLookDone: true });
    // The next reply takes the item path: a confirmed curb is said, at priority 1.
    const next = mergeReply(EMPTY_MEMORY, { summary: 'A sidewalk with a curb', items: [steps({ label: 'curb', ground: 'curb' })] }, 12_000);
    const d = decide({ reply: { summary: 'A sidewalk with a curb', change: 'minor' }, merged: next, verbosity: 'normal', state: undone, now: 12_000 });
    assert.equal(d.note, 'item');
    assert.equal(d.announcement?.priority, 1);
  });
});
