/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_MEMORY, MEMORY, contextFor, expire, itemKey, markSpoken, mergeReply } from './scene-memory.ts';
import { sceneItem } from './scene-test-helpers.ts';

describe('scene memory', () => {
  it('adds new items and reports which are fresh', () => {
    const { memory, fresh, reported } = mergeReply(
      EMPTY_MEMORY,
      { summary: 'A hallway.', items: [sceneItem('door', { kind: 'landmark' }), sceneItem('chair')] },
      1000,
    );
    assert.deepEqual(memory.items.map((i) => i.key), ['door', 'chair']);
    assert.deepEqual(fresh.map((i) => i.key), ['door', 'chair']);
    assert.deepEqual(reported.map((i) => i.key), ['door', 'chair']);
    assert.deepEqual(memory.summaries, [{ text: 'A hallway.', at: 1000 }]);
    assert.equal(memory.items[0].firstSeenAt, 1000);
    assert.equal(memory.items[0].lastSpokenAt, null);
  });

  it('updates a known item in place and keeps when it was first seen and spoken', () => {
    let { memory } = mergeReply(EMPTY_MEMORY, { summary: null, items: [sceneItem('chair')] }, 1000);
    memory = markSpoken(memory, ['chair'], 1500);
    const merged = mergeReply(memory, { summary: null, items: [sceneItem('Chair', { position: 'left', status: 'moved' })] }, 5000);
    assert.equal(merged.fresh.length, 0);
    const [chair] = merged.memory.items;
    assert.equal(chair.position, 'left');
    assert.equal(chair.status, 'moved');
    assert.equal(chair.firstSeenAt, 1000);
    assert.equal(chair.lastSeenAt, 5000);
    assert.equal(chair.lastSpokenAt, 1500);
  });

  it('removes gone items and forgets items not seen for a while', () => {
    let { memory } = mergeReply(EMPTY_MEMORY, { summary: null, items: [sceneItem('door'), sceneItem('chair')] }, 0);
    memory = mergeReply(memory, { summary: null, items: [sceneItem('door', { status: 'gone' })] }, 1000).memory;
    assert.deepEqual(memory.items.map((i) => i.key), ['chair']);
    assert.equal(expire(memory, MEMORY.expireMs).items.length, 1);
    assert.equal(expire(memory, MEMORY.expireMs + 1).items.length, 0);
    // An expired item comes back as fresh.
    const again = mergeReply(memory, { summary: null, items: [sceneItem('chair')] }, MEMORY.expireMs + 1);
    assert.deepEqual(again.fresh.map((i) => i.key), ['chair']);
  });

  it('keeps the last three summaries', () => {
    let memory = EMPTY_MEMORY;
    for (let i = 0; i < 5; i++) memory = mergeReply(memory, { summary: `S${i}.`, items: [] }, i).memory;
    assert.deepEqual(memory.summaries.map((s) => s.text), ['S2.', 'S3.', 'S4.']);
    assert.equal(mergeReply(memory, { summary: null, items: [] }, 9).memory.summaries.length, 3);
  });

  it('builds a compact context, most recently seen first', () => {
    let { memory } = mergeReply(EMPTY_MEMORY, { summary: 'A kitchen.', items: [sceneItem('table'), sceneItem('sink')] }, 0);
    memory = mergeReply(memory, { summary: null, items: [sceneItem('sink', { position: 'right' })] }, 4000).memory;
    memory = markSpoken(memory, ['table'], 4100);
    assert.deepEqual(contextFor(memory, 6400), {
      summary: 'A kitchen.',
      items: [
        { label: 'sink', kind: 'object', position: 'right', age_s: 2, spoken: false },
        { label: 'table', kind: 'object', position: 'center', age_s: 6, spoken: true },
      ],
    });
    assert.deepEqual(contextFor(EMPTY_MEMORY, 0), { summary: null, items: [] });
  });

  it('normalizes keys', () => {
    assert.equal(itemKey('  Office   Chair '), 'office chair');
  });
});
