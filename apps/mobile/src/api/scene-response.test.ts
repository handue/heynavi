/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSceneItem, parseSceneResponse } from './scene-response.ts';

const ITEM = {
  label: 'office chair',
  count: 2,
  kind: 'possible_obstacle',
  position: 'center',
  band: 'lower',
  status: 'new',
  importance: 'high',
  ground: 'chair',
  text: null,
};

const BODY = {
  session_id: 's1',
  frame_id: 4,
  summary: 'A hallway.',
  change: 'major',
  items: [ITEM],
  filtered: ['summary_distance'],
  timings_ms: { spark: 3400.5, parse: 0.4, total: 3410 },
  usage: { input_tokens: 1600, output_tokens: 500, reasoning_tokens: 400, cost_usd: 0.0041 },
};

describe('parseSceneResponse', () => {
  it('parses a full body', () => {
    const parsed = parseSceneResponse(BODY);
    assert.ok(parsed);
    assert.equal(parsed.summary, 'A hallway.');
    assert.equal(parsed.items[0].label, 'office chair');
    assert.deepEqual(parsed.filtered, ['summary_distance']);
    assert.equal(parsed.timings_ms?.spark, 3400.5);
    assert.equal(parsed.usage?.cost_usd, 0.0041);
  });

  it('skips malformed items and tolerates missing timings and usage', () => {
    const parsed = parseSceneResponse({
      ...BODY,
      summary: null,
      items: [ITEM, { ...ITEM, label: 'Chair!' }, { ...ITEM, kind: 'thing' }, { ...ITEM, count: 0 }, 'x'],
      timings_ms: null,
      usage: undefined,
      filtered: 'nope',
    });
    assert.ok(parsed);
    assert.equal(parsed.summary, null);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.timings_ms, null);
    assert.equal(parsed.usage, null);
    assert.deepEqual(parsed.filtered, []);
  });

  it('rejects bodies that are not scene responses', () => {
    assert.equal(parseSceneResponse(null), null);
    assert.equal(parseSceneResponse({ ...BODY, change: 'huge' }), null);
    assert.equal(parseSceneResponse({ ...BODY, frame_id: '4' }), null);
    assert.equal(parseSceneResponse({ ...BODY, items: {} }), null);
    assert.equal(parseSceneResponse({ ...BODY, summary: 3 }), null);
  });
});

describe('parseSceneItem', () => {
  it('keeps text only for text items and drops a bad ground concept', () => {
    assert.equal(parseSceneItem({ ...ITEM, text: 'EXIT' })?.text, null);
    assert.equal(parseSceneItem({ ...ITEM, kind: 'text', text: 'EXIT' })?.text, 'EXIT');
    assert.equal(parseSceneItem({ ...ITEM, ground: 'Chair!' })?.ground, null);
    assert.equal(parseSceneItem({ ...ITEM, ground: '' })?.ground, null);
  });
});
