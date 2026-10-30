/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Position } from '../agent/types.ts';
import { analyze, parse } from '../voice/command-grammar.ts';
import { direction, scenePhrases, where } from './scene-phrases.ts';
import type { Band, Verbosity } from './types.ts';
import { checkCameraText, clauses, unspeakableReason } from './wording.ts';

const POSITIONS: Position[] = ['left', 'center', 'right'];
const BANDS: Band[] = ['lower', 'middle', 'upper'];
const LEVELS: Verbosity[] = ['quiet', 'normal', 'detailed'];
// Labels Spark may return, including ones that contain command words.
const LABELS = ['chair', 'person', 'open door', 'stop sign', 'help desk', 'pause button', 'office chair', 'umbrella', 'stairs', 'step', 'steps', 'box', 'clothing', 'curb'];

function spokenLines(): string[] {
  const p = scenePhrases;
  const lines: string[] = [p.exploreStart(), p.describeAck(), p.cannotAnswer(), p.nothingNotable(), p.updatesPaused(), p.updatesResumed(), p.updatesAlreadyOn()];
  for (const v of LEVELS) lines.push(p.verbosity(v), p.verbosityLimit(v));
  for (const label of LABELS) {
    for (const position of POSITIONS) {
      for (const band of BANDS) {
        for (const count of [1, 3]) {
          const item = { label, count, position, band };
          for (const frame of ['forward', 'camera'] as const) {
            lines.push(p.item(item, frame), p.obstacle(item, frame), p.textUnreadable(item, frame), p.text(item, 'Exit', frame));
            for (const kind of ['possible_obstacle', 'level_change', 'person'] as const) {
              lines.push(p.visible({ ...item, kind }, frame), p.uncertain({ ...item, kind }, frame));
            }
          }
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
  it('says directions relative to the user only for a forward-held phone', () => {
    assert.equal(direction('left', 'lower', 'forward'), 'ahead on your left');
    assert.equal(direction('center', 'upper', 'forward'), 'directly ahead');
    assert.equal(direction('right', 'middle', 'camera'), 'on the right of the camera view');
  });

  it('says what is visible, plainly or hedged, like the walking examples', () => {
    const f = 'forward' as const;
    assert.equal(scenePhrases.visible({ label: 'bag', count: 1, position: 'center', band: 'lower', kind: 'possible_obstacle' }, f), 'A bag is visible on the floor ahead.');
    assert.equal(scenePhrases.visible({ label: 'steps', count: 1, position: 'center', band: 'lower', kind: 'level_change' }, f), 'Steps are visible ahead.');
    assert.equal(scenePhrases.visible({ label: 'person', count: 1, position: 'right', band: 'middle', kind: 'person' }, f), 'A person is visible ahead on your right.');
    assert.equal(scenePhrases.uncertain({ label: 'curb', count: 1, position: 'left', band: 'lower', kind: 'level_change' }, f), 'There may be a curb ahead on your left.');
    assert.equal(scenePhrases.visible({ label: 'clothing', count: 3, position: 'center', band: 'lower', kind: 'possible_obstacle' }, 'camera'), 'Some clothing is visible in the lower center of the camera view.');
  });

  it('places things relative to the camera view', () => {
    assert.equal(where('left', 'middle'), 'on the left of the camera view');
    assert.equal(where('center', 'lower'), 'in the lower center of the camera view');
    assert.equal(where('right', 'upper'), 'in the upper right of the camera view');
  });

  it('counts and pluralizes', () => {
    assert.equal(scenePhrases.item({ label: 'person', count: 3, position: 'left', band: 'middle' }), 'There are 3 people on the left of the camera view.');
    assert.equal(scenePhrases.item({ label: 'umbrella', count: 1, position: 'right', band: 'lower' }), "There's an umbrella in the lower right of the camera view.");
    assert.equal(scenePhrases.item({ label: 'step', count: 3, position: 'center', band: 'lower' }, 'forward'), 'There are steps directly ahead.');
    assert.equal(scenePhrases.item({ label: 'stairs', count: 1, position: 'left', band: 'lower' }, 'forward'), 'There are stairs ahead on your left.');
    assert.equal(scenePhrases.obstacle({ label: 'box', count: 1, position: 'center', band: 'lower' }, 'forward'), 'Possible obstacle: a box directly ahead.');
    assert.equal(scenePhrases.item({ label: 'person', count: 1, position: 'right', band: 'middle' }, 'forward'), "There's a person ahead on your right.");
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
