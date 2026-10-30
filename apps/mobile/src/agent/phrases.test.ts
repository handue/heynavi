/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyze, parse } from '../voice/command-grammar.ts';
import {
  CONCEPTS,
  CONCEPT_IDS,
  conceptLabel,
  phrases,
  pluralize,
  type ErrorKind,
  type Phrasebook,
} from './phrases.ts';
import type { Position, SearchStatus } from './types.ts';

const en = phrases('en-US');

describe('concepts', () => {
  it('has the six VS-1 concepts', () => {
    assert.deepEqual(CONCEPT_IDS, ['chair', 'cup', 'bottle', 'door', 'person', 'bag']);
    assert.equal(conceptLabel('cup', 'en-US'), 'cup');
    assert.equal(conceptLabel('umbrella'), 'umbrella', 'unknown concepts fall back to the noun');
    assert.equal(CONCEPTS.person.enPlural, 'people');
  });

  it('speaks spoken (voice) concepts naturally', () => {
    assert.equal(en.start('keys'), 'Looking for keys. Move your phone slowly.');
    assert.equal(en.start('umbrella'), 'Looking for an umbrella. Move your phone slowly.');
    assert.equal(en.start('tv'), 'Looking for a TV. Move your phone slowly.');
    assert.equal(en.found('blue water bottle', 'right', null), 'I found a blue water bottle, on the right of the camera view.');
    assert.equal(en.foundMany('couch', 2, 'left', null), 'I see 2 couches. The largest is on the left.');
    assert.deepEqual(['glass', 'box', 'puppy', 'trash can', 'day'].map(pluralize), [
      'glasses',
      'boxes',
      'puppies',
      'trash cans',
      'days',
    ]);
  });
});

describe('English phrases', () => {
  it('matches the specified lines', () => {
    assert.equal(en.start('chair'), 'Looking for a chair. Move your phone slowly.');
    assert.equal(en.found('chair', 'left', null), 'I found a chair, on the left of the camera view.');
    assert.equal(en.lost('chair'), 'I lost sight of the chair. Still looking.');
    assert.equal(en.coaching('chair', 0), 'Still looking for a chair. Try turning slowly.');
    assert.equal(en.stop(), 'Stopped searching.');
    assert.equal(en.error('network'), "I can't reach the server. I'll keep trying.");
  });

  it('describes several instances and size', () => {
    assert.equal(en.foundMany('chair', 2, 'center', null), 'I see 2 chairs. The largest is in the center.');
    assert.equal(
      en.foundMany('person', 3, 'right', 'close'),
      'I see 3 people. The largest is on the right. It looks close.',
    );
    assert.equal(
      en.found('bottle', 'center', 'far'),
      'I found a bottle, in the center of the camera view. It looks far away.',
    );
  });

  it('guides by camera-view position', () => {
    assert.deepEqual(
      (['left', 'center', 'right'] as Position[]).map(en.guide),
      ['Now on the left.', 'Centered.', 'Now on the right.'],
    );
  });

  it('labels the toggle button', () => {
    assert.equal(en.ui.stopButton, 'End search');
  });

  it('has the specified voice replies', () => {
    assert.equal(
      en.voice.help(),
      "Ask about your surroundings, like what's in front of me, or where is the door. Say find and an object to search for it. Say quieter, or more detail. Say pause, resume, or repeat. To end a search, say cancel.",
    );
    assert.equal(en.voice.listeningLost(), "Voice commands stopped. I'll keep trying. The buttons still work.");
    assert.equal(en.ui.stopHint, 'Ends the search. You can also say stop searching, or say pause.');
    assert.equal(en.ui.pausedHint, 'Ends the search. To continue it, say resume.');
    assert.equal(en.voice.notUnderstood(), "Sorry, I didn't catch that. Say help to hear what I can do.");
  });
});

const POSITIONS: Position[] = ['left', 'center', 'right'];
const STATUSES: SearchStatus[] = ['IDLE', 'SEARCHING', 'CONFIRMING', 'FOUND', 'GUIDING', 'LOST', 'PAUSED', 'CANCELLED'];
const ERRORS: ErrorKind[] = ['network', 'slow', 'unauthorized', 'notConfigured', 'cantAnalyze', 'server', 'camera', 'budget'];
// Spoken goals whose names contain a command word, too: "stop sign", "help desk".
const SPOKEN_CONCEPTS = [
  ...CONCEPT_IDS,
  'keys',
  'tv',
  'umbrella',
  'blue water bottle',
  'stop sign',
  'bus stop',
  'help desk',
  'pause button',
];

/** Every line the app speaks (TTS), except the help line. */
function spokenLines(p: Phrasebook): string[] {
  const lines: string[] = [p.stop(), p.reconnected()];
  for (const c of SPOKEN_CONCEPTS) {
    lines.push(p.start(c), p.lost(c), p.checkIn(c), p.resume(c));
    for (let i = 0; i < 4; i++) lines.push(p.coaching(c, i));
    for (const pos of POSITIONS) {
      for (const size of ['close', 'far', null] as const) {
        lines.push(p.found(c, pos, size), p.foundMany(c, 2, pos, size));
      }
    }
  }
  for (const pos of POSITIONS) lines.push(p.guide(pos));
  for (const e of ERRORS) lines.push(p.error(e));
  const v = p.voice;
  lines.push(v.notUnderstood(), v.paused(), v.nothingToPause(), v.nothingToResume(), v.nothingToRepeat());
  lines.push(v.listeningLost());
  lines.push(v.cameraNotReady());
  return lines;
}

/** Every string VoiceOver reads aloud on the camera screen. */
function uiStrings(p: Phrasebook): string[] {
  const { ui } = p;
  const lines: string[] = [ui.stopButton, ui.stopHint, ui.pausedHint, ...Object.values(ui.mic.status)];
  lines.push(ui.mic.turnOff, ui.mic.turnOffHint, ui.mic.turnOn, ui.mic.turnOnHint);
  lines.push(ui.mic.allow, ui.mic.allowHint, ui.mic.openSettings, ui.mic.openSettingsHint);
  for (const s of STATUSES) lines.push(ui.status(s));
  return lines;
}

/** The recognizer may cut a line into segments at any pause: sentences and clauses. */
function clauses(line: string): string[] {
  return line
    .split(/[.,:;!?]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

describe('safety wording', () => {
  it('never claims distances in meters or steps, or that anything is safe', () => {
    const forbidden = /\d\s*(m|meters?|feet|ft|steps?)\b|meter|step|safe/i;
    const lines = [...spokenLines(en), en.voice.help(), ...uiStrings(en)];
    for (const line of lines) {
      assert.ok(line.length > 0);
      assert.doesNotMatch(line, forbidden, line);
      assert.doesNotMatch(line, /undefined|NaN/, line);
    }
  });
});

describe('voice audit: HeyNavi must not command itself', () => {
  it('no spoken line, or clause of one, parses as a voice command', () => {
    for (const line of spokenLines(en)) {
      assert.equal(parse(line), null, line);
      for (const clause of clauses(line)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
    }
  });

  it('no VoiceOver string, or clause of one, parses as a voice command', () => {
    for (const line of uiStrings(en)) {
      assert.equal(parse(line), null, line);
      for (const clause of clauses(line)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
    }
  });

  it('nothing the app says or shows contains the wake word', () => {
    for (const line of [...spokenLines(en), en.voice.help(), ...uiStrings(en)]) {
      assert.doesNotMatch(line, /navi|navy/i, line);
      assert.equal(analyze(line).wake, false, line);
    }
  });

  it('the help line as a whole is not a command (its clauses are; the echo gate handles those)', () => {
    assert.equal(parse(en.voice.help()), null);
  });

  it('the help line names no "stop", so the user can say it over the line', () => {
    assert.doesNotMatch(en.voice.help(), /\bstop/i);
  });
});
