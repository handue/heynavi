/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { phrases } from '../agent/phrases.ts';
import type { SearchStatus } from '../agent/types.ts';
import { planCommand, stopsSpeech, type VoiceContext } from './voice-actions.ts';

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
