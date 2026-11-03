/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LastLook } from '../scene/scene-controller.ts';
import { analyze, parse } from '../voice/command-grammar.ts';
import { decision, footer, panelItems, panelLabel, samTally, seconds, sparkMeta } from './agent-panel-model.ts';

const LOOK: LastLook = {
  frame: 12,
  change: 'minor',
  items: [
    { label: 'box', count: 2, kind: 'possible_obstacle', importance: 'high', sam: 'found', confidence: 0.816, considered: true },
    { label: 'person', count: 1, kind: 'person', importance: 'medium', sam: 'missed', confidence: null, considered: true },
    { label: 'poster', count: 1, kind: 'object', importance: 'low', sam: 'unchecked', confidence: null, considered: false },
  ],
  note: 'item',
  said: 'Possible obstacle: 2 boxes directly ahead.',
  sparkMs: 2940,
  samMs: 612,
  totalMs: 4120,
  costUsd: 0.00812,
};

describe('decision panel text', () => {
  it('lists what Spark saw with SAM verdicts and the line HeyNavi chose', () => {
    assert.deepEqual(
      panelItems(LOOK).map((i) => [i.label, i.detail, i.samText, i.considered]),
      [
        ['box ×2', 'obstacle · high', '82%', true],
        ['person', 'person · medium', 'not found', true],
        ['poster', 'object · low', 'not checked', false],
      ],
    );
    assert.equal(samTally(LOOK), '1 of 2 found');
    assert.equal(sparkMeta(LOOK), '2.9 s · small change');
    assert.deepEqual(decision(LOOK), { spoke: true, text: 'Possible obstacle: 2 boxes directly ahead.' });
    assert.equal(footer(LOOK, 5, 3), 'Look 12 · 4.1 s photo to decision · remembers 5, told 3 · $0.0081');
    assert.equal(seconds(null), '–');
  });

  it('says why HeyNavi held back', () => {
    const quiet = (note: LastLook['note']) => decision({ ...LOOK, said: null, note });
    assert.deepEqual(quiet('nothing-new'), { spoke: false, text: 'Nothing new to mention' });
    assert.equal(quiet('gap').text, 'Held back: it spoke moments ago');
    assert.equal(quiet('rate').text, 'Held back: enough lines this minute');
    assert.equal(quiet('unspeakable').text, 'Held back by the wording filter');
    assert.equal(samTally({ ...LOOK, items: [] }), 'nothing checked');
  });

  it('voice audit: what VoiceOver reads is never a command and has no wake word', () => {
    const labels = [
      panelLabel(null, 0, 0),
      panelLabel(LOOK, 5, 3),
      ...(['nothing-new', 'gap', 'rate', 'unspeakable'] as const).map((note) => panelLabel({ ...LOOK, said: null, note }, 1, 0)),
    ];
    for (const label of labels) {
      assert.match(label, /^Decision panel\./, label);
      assert.equal(analyze(label).wake, false, label);
      assert.equal(parse(label), null, label);
      for (const sentence of label.split(/\.\s+/)) assert.equal(parse(sentence), null, `"${sentence}" in "${label}"`);
    }
  });
});
