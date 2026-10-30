/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { phrases } from '../agent/phrases.ts';
import type { SearchStatus } from '../agent/types.ts';
import { planCommand, startsSearch, stopsSpeech, type VoiceContext } from './voice-actions.ts';

const voice = phrases('en-US').voice;

const ctx = (status: SearchStatus, speaking = false, canSearch = true, speakingAtStart?: boolean): VoiceContext => ({
  status,
  speaking,
  canSearch,
  speakingAtStart,
});
const types = (actions: ReturnType<typeof planCommand>) => actions.map((a) => a.type);

describe('voice command semantics', () => {
  it('find starts (or replaces) the goal, if the camera can search', () => {
    assert.deepEqual(planCommand({ type: 'find', concept: 'cup', spoken: 'mug' }, ctx('GUIDING')), [
      { type: 'start', concept: 'cup' },
    ]);
    assert.deepEqual(planCommand({ type: 'find', concept: 'cup', spoken: 'cup' }, ctx('IDLE', false, false)), [
      { type: 'reply', key: 'camera-not-ready', text: voice.cameraNotReady() },
    ]);
  });

  it('"stop" stops the speech while speaking, otherwise the search', () => {
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('SEARCHING', true))), ['silence']);
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('SEARCHING'))), ['stop-search']);
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('PAUSED'))), ['stop-search']);
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('IDLE'))), []);
  });

  it('"stop" means what it meant when the user began saying it', () => {
    // Said in silence; a guidance line started before the final arrived.
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('GUIDING', true, true, false))), ['silence', 'stop-search']);
    // Said over speech that has ended since: nothing left to stop, and the search goes on.
    assert.deepEqual(types(planCommand({ type: 'stop' }, ctx('GUIDING', false, true, true))), []);
  });

  it('"cancel" stops both; "quiet" only the speech', () => {
    assert.deepEqual(types(planCommand({ type: 'cancel' }, ctx('GUIDING', true))), ['silence', 'stop-search']);
    assert.deepEqual(types(planCommand({ type: 'cancel' }, ctx('IDLE', true))), ['silence']);
    assert.deepEqual(types(planCommand({ type: 'cancel' }, ctx('CANCELLED'))), []);
    assert.deepEqual(types(planCommand({ type: 'quiet' }, ctx('SEARCHING', true))), ['silence']);
    assert.deepEqual(types(planCommand({ type: 'quiet' }, ctx('SEARCHING'))), []);
  });

  it('pause and resume act on the search and say so', () => {
    assert.deepEqual(planCommand({ type: 'pause' }, ctx('SEARCHING')), [
      { type: 'pause' },
      { type: 'reply', key: 'paused', text: 'Paused.' },
    ]);
    assert.deepEqual(types(planCommand({ type: 'pause' }, ctx('PAUSED'))), ['reply']);
    assert.deepEqual(planCommand({ type: 'pause' }, ctx('IDLE')), [
      { type: 'reply', key: 'nothing-to-pause', text: voice.nothingToPause() },
    ]);
    assert.deepEqual(types(planCommand({ type: 'resume' }, ctx('PAUSED'))), ['resume']);
    assert.deepEqual(types(planCommand({ type: 'resume' }, ctx('SEARCHING'))), []);
    assert.deepEqual(planCommand({ type: 'resume' }, ctx('CANCELLED')), [
      { type: 'reply', key: 'nothing-to-resume', text: voice.nothingToResume() },
    ]);
  });

  it('repeat and help', () => {
    assert.deepEqual(types(planCommand({ type: 'repeat' }, ctx('GUIDING'))), ['repeat']);
    assert.deepEqual(planCommand({ type: 'help' }, ctx('IDLE')), [
      { type: 'reply', key: 'help', text: voice.help() },
    ]);
  });

  it('knows which actions start a stop-latency sample', () => {
    assert.equal(stopsSpeech(planCommand({ type: 'stop' }, ctx('SEARCHING', true))), true);
    assert.equal(stopsSpeech(planCommand({ type: 'cancel' }, ctx('SEARCHING'))), true);
    assert.equal(stopsSpeech(planCommand({ type: 'help' }, ctx('SEARCHING'))), false);
  });
});

describe('scene update commands', () => {
  const exploring = (status: SearchStatus = 'IDLE', speaking = false, scene = { running: true, pausedByUser: false }): VoiceContext => ({
    status,
    speaking,
    canSearch: true,
    scene,
  });
  const held = { running: false, pausedByUser: true };

  it('"stop" in silence holds the updates when no search runs', () => {
    assert.deepEqual(types(planCommand({ type: 'stop' }, exploring())), ['pause-updates', 'reply']);
    assert.deepEqual(types(planCommand({ type: 'stop' }, exploring('SEARCHING'))), ['stop-search']);
    // Over speech it still only silences.
    assert.deepEqual(types(planCommand({ type: 'stop' }, exploring('IDLE', true))), ['silence']);
  });

  it('"cancel" never holds the updates', () => {
    assert.deepEqual(types(planCommand({ type: 'cancel' }, exploring('IDLE', true))), ['silence']);
    assert.deepEqual(types(planCommand({ type: 'cancel' }, exploring())), []);
  });

  it('"pause" and "resume" act on the search first, then on the updates', () => {
    assert.deepEqual(types(planCommand({ type: 'pause' }, exploring('SEARCHING'))), ['pause', 'reply']);
    assert.deepEqual(types(planCommand({ type: 'pause' }, exploring())), ['pause-updates', 'reply']);
    assert.deepEqual(types(planCommand({ type: 'resume' }, exploring('IDLE', false, held))), ['resume-updates', 'reply']);
    assert.deepEqual(types(planCommand({ type: 'resume' }, exploring())), []);
    assert.deepEqual(types(planCommand({ type: 'resume' }, exploring('PAUSED', false, held))), ['resume']);
  });

  it('"updates off" and "updates on" toggle the user hold and say so', () => {
    assert.deepEqual(types(planCommand({ type: 'updates-off' }, exploring())), ['pause-updates', 'reply']);
    assert.deepEqual(planCommand({ type: 'updates-off' }, exploring('IDLE', false, held)), [
      { type: 'reply', key: 'updates-paused', text: 'Updates paused. To hear them again, say resume.' },
    ]);
    assert.deepEqual(types(planCommand({ type: 'updates-on' }, exploring('IDLE', false, held))), ['resume-updates', 'reply']);
    assert.deepEqual(planCommand({ type: 'updates-on' }, exploring()), [
      { type: 'reply', key: 'updates-on', text: 'Updates are already on.' },
    ]);
  });

  it('describe and verbosity', () => {
    assert.deepEqual(planCommand({ type: 'describe' }, exploring('GUIDING')), [{ type: 'describe' }]);
    assert.deepEqual(types(planCommand({ type: 'describe' }, { ...exploring(), canSearch: false })), ['reply']);
    assert.deepEqual(planCommand({ type: 'more-updates' }, exploring()), [{ type: 'verbosity', delta: 1 }]);
    assert.deepEqual(planCommand({ type: 'fewer-updates' }, exploring()), [{ type: 'verbosity', delta: -1 }]);
  });

  it('holding the updates is a stop-latency sample', () => {
    assert.equal(stopsSpeech(planCommand({ type: 'stop' }, exploring())), true);
  });
});

describe('questions (M4)', () => {
  it('asks when the camera is ready', () => {
    assert.deepEqual(planCommand({ type: 'ask', question: 'where is the door' }, ctx('IDLE')), [{ type: 'ask', question: 'where is the door' }]);
    assert.deepEqual(types(planCommand({ type: 'ask', question: 'where is the door' }, ctx('IDLE', false, false))), ['reply']);
  });

  it('lets only a where-question start a search', () => {
    assert.equal(startsSearch('where is the entrance'), true);
    assert.equal(startsSearch("where's my cup"), true);
    assert.equal(startsSearch('what objects are nearby what projector nearby'), false);
    assert.equal(startsSearch('is there a door'), false);
  });
});
