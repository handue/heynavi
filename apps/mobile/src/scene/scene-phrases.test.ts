/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Position } from '../agent/types.ts';
import { analyze, parse } from '../voice/command-grammar.ts';
import { scenePhrases, where } from './scene-phrases.ts';
import type { Band, Verbosity } from './types.ts';
import { checkCameraText, clauses, unspeakableReason } from './wording.ts';

const POSITIONS: Position[] = ['left', 'center', 'right'];
const BANDS: Band[] = ['lower', 'middle', 'upper'];
const LEVELS: Verbosity[] = ['quiet', 'normal', 'detailed'];
// Labels Spark may return, including ones that contain command words.
const LABELS = ['chair', 'person', 'open door', 'stop sign', 'help desk', 'pause button', 'office chair', 'umbrella', 'stairs'];

function spokenLines(): string[] {
  const p = scenePhrases;
  const lines: string[] = [p.exploreStart(), p.describeAck(), p.nothingNotable(), p.updatesPaused(), p.updatesResumed(), p.updatesAlreadyOn()];
  for (const v of LEVELS) lines.push(p.verbosity(v), p.verbosityLimit(v));
  for (const label of LABELS) {
    for (const position of POSITIONS) {
      for (const band of BANDS) {
        for (const count of [1, 3]) {
          const item = { label, count, position, band };
          lines.push(p.item(item), p.textUnreadable(item), p.text(item, 'Exit'));
        }
      }
    }
  }
  lines.push(p.items([{ label: 'door', count: 1, position: 'right', band: 'middle' }, { label: 'chair', count: 2, position: 'left', band: 'lower' }]));
  return lines;
}

function uiStrings(): string[] {
  const { ui } = scenePhrases;
  return [ui.observing, ui.paused, ui.searching, ui.starting, ui.pauseButton, ui.pauseHint, ui.resumeButton, ui.resumeHint, ui.describeButton, ui.describeHint, ui.lastSaid, ...LEVELS.map(ui.verbosity)];
}

describe('scene phrases', () => {
  it('places things relative to the camera view', () => {
    assert.equal(where('left', 'middle'), 'on the left of the camera view');
    assert.equal(where('center', 'lower'), 'in the lower center of the camera view');
    assert.equal(where('right', 'upper'), 'in the upper right of the camera view');
  });

  it('counts and pluralizes', () => {
    assert.equal(scenePhrases.item({ label: 'person', count: 3, position: 'left', band: 'middle' }), 'I see 3 people on the left of the camera view.');
    assert.equal(scenePhrases.item({ label: 'umbrella', count: 1, position: 'right', band: 'lower' }), 'I see an umbrella in the lower right of the camera view.');
    assert.equal(scenePhrases.summary('A hallway'), 'A hallway.');
    assert.equal(scenePhrases.summary('A hallway!'), 'A hallway!');
  });

  it('every template line passes the wording filter', () => {
    for (const line of spokenLines()) assert.equal(checkCameraText(line), null, line);
  });
});

describe('voice audit: scene lines must not command HeyNavi', () => {
  it('no spoken line or clause parses as a command, and none has the wake word', () => {
    for (const line of spokenLines()) {
      assert.equal(parse(line), null, line);
      for (const clause of clauses(line)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
      assert.equal(analyze(line).wake, false, line);
      assert.equal(unspeakableReason(line), null, line);
    }
  });

  it('no VoiceOver string or clause parses as a command, and none has the wake word', () => {
    for (const line of uiStrings()) {
      assert.doesNotMatch(line, /navi|navy/i, line);
      assert.doesNotMatch(line, /^stop/i, line);
      assert.equal(parse(line), null, line);
      for (const clause of clauses(line)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
    }
  });
});

describe('unspeakableReason', () => {
  it('blocks model text that would command HeyNavi or break the wording rules', () => {
    assert.equal(unspeakableReason('I see a sign. It reads: Stop.'), 'command');
    assert.equal(unspeakableReason('Stop sign ahead.'), 'direction');
    assert.equal(unspeakableReason('The path ahead is clear.'), 'safety');
    assert.equal(unspeakableReason('I see a poster. It reads: Cancel.'), 'command');
    assert.equal(unspeakableReason('I see a sign. It reads: Navi.'), 'wake_word');
    assert.equal(unspeakableReason('A hallway, about 3 meters long.'), 'distance');
    assert.equal(unspeakableReason('A hallway with a door on the right.'), null);
  });
});
