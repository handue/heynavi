/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// Uses the real sentences from phrases.ts, as the microphone would hear them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { phrases } from '../agent/phrases.ts';
import { analyze } from './command-grammar.ts';
import {
  ECHO,
  alignEcho,
  bargeInHead,
  bargeInTail,
  contentStems,
  gate,
  overlapRatio,
  stem,
  type EchoInput,
} from './echo-gate.ts';

const en = phrases('en-US');
const FOUND = en.found('chair', 'left', null);
const STOPPED = en.stop();
const HELP = en.voice.help();

/** Builds the gate input from a transcript, as the controller does. */
function input(transcript: string, speech: Partial<EchoInput> = {}): EchoInput {
  const a = analyze(transcript);
  return {
    transcript,
    command: a.command,
    wake: a.wake,
    isFinal: true,
    speaking: false,
    currentUtterance: null,
    lastUtterance: null,
    lastSpeechEndedAt: null,
    now: 10_000,
    ...speech,
  };
}

const speaking = (utterance: string): Partial<EchoInput> => ({ speaking: true, currentUtterance: utterance });
const endedAgo = (utterance: string, ms: number): Partial<EchoInput> => ({
  lastUtterance: utterance,
  lastSpeechEndedAt: 10_000 - ms,
});

describe('stem and overlap', () => {
  it('matches inflections of the same word, and only those', () => {
    assert.equal(stem('stopped'), stem('stop'));
    assert.equal(stem('searching'), stem('search'));
    assert.equal(stem('paused'), stem('pause'));
    assert.equal(stem('chairs'), stem('chair'));
    assert.notEqual(stem('found'), stem('find'));
    assert.notEqual(stem('stop'), stem('step'));
  });

  it('ignores function words and treats HeyNavi as "hey navi"', () => {
    assert.deepEqual(contentStems('Find a chair, please.'), ['find', 'chair']);
    assert.deepEqual(contentStems('HeyNavi'), ['hey', 'navi']);
    assert.equal(overlapRatio('stop searching', [STOPPED]), 1);
    assert.equal(overlapRatio('find a chair', [FOUND]), 0.5);
    assert.equal(overlapRatio('', [FOUND]), 0);
  });
});

describe('while HeyNavi speaks', () => {
  it('lets the user barge in with stop, cancel and quiet', () => {
    for (const t of ['stop', 'stop searching', 'cancel', 'never mind', 'be quiet', 'stop talking']) {
      assert.deepEqual(gate(input(t, speaking(FOUND))), { allow: true }, t);
    }
  });

  it('drops a barge-in made of the words being spoken ("Stopped searching." must not cancel)', () => {
    assert.equal(gate(input('stop searching', speaking(STOPPED))).allow, false);
    assert.equal(gate(input('stop', speaking(STOPPED))).allow, false);
    assert.equal(gate(input('stop', { ...speaking(STOPPED), isFinal: false })).allow, false);
  });

  it('drops every other command, unless it starts with the wake phrase', () => {
    assert.deepEqual(gate(input('find a cup', speaking(FOUND))), { allow: false, reason: 'speaking' });
    assert.deepEqual(gate(input('repeat', speaking(FOUND))), { allow: false, reason: 'speaking' });
    assert.deepEqual(gate(input('Hey Navi, find a cup', speaking(FOUND))), { allow: true });
  });

  it('drops the commands the help line itself names, clause by clause', () => {
    const clauses = [
      'say find and an object',
      'like find a chair',
      'find a chair',
      'say pause',
      'pause',
      'resume',
      'or repeat',
      'repeat',
      'to end the search',
      'say cancel',
      'cancel',
    ];
    for (const t of clauses) {
      assert.equal(gate(input(t, speaking(HELP))).allow, false, t);
      assert.equal(gate(input(t, { ...speaking(HELP), isFinal: false })).allow, false, `${t} (interim)`);
    }
    // The barge-ins the help line does not contain still work: above all "stop".
    for (const t of ['stop', 'never mind', 'be quiet']) assert.equal(gate(input(t, speaking(HELP))).allow, true, t);
  });

  it('drops a transcript of the utterance itself (self-transcription)', () => {
    const lost = en.lost('chair');
    assert.deepEqual(gate(input('I lost sight of the chair', speaking(lost))), { allow: false, reason: 'self-echo' });
    // "stop looking" shares only "looking" with "Still looking.": the user, not an echo.
    assert.equal(gate(input('stop looking', speaking(lost))).allow, true);
  });
});

describe('after HeyNavi spoke', () => {
  it('keeps treating transcripts as overlapping speech for the 400 ms tail', () => {
    assert.equal(gate(input('repeat', endedAgo(FOUND, ECHO.tailMs - 50))).allow, false);
    assert.equal(gate(input('repeat', endedAgo(FOUND, ECHO.tailMs + 50))).allow, true);
    assert.equal(gate(input('stop', endedAgo(STOPPED, 100))).allow, false, 'tail checks the last utterance');
  });

  it('drops a late final whose segment began while HeyNavi spoke', () => {
    // The help line's "pause" clause, finalized 600 ms after the line ended.
    const late = { ...endedAgo(HELP, 600), segmentStartedAt: 10_000 - 900 };
    assert.deepEqual(gate(input('pause', late)), { allow: false, reason: 'self-echo' });
    const resume = en.resume('chair');
    assert.equal(gate(input('again', { ...endedAgo(resume, 1000), segmentStartedAt: 10_000 - 1200 })).allow, false);
  });

  it('accepts the user answering a line with a word from it, once the line is over', () => {
    // "Sorry, ... Say help to hear what I can do." -> the user says "help" after it ended.
    const reply = { ...endedAgo(en.voice.notUnderstood(), 1200), segmentStartedAt: 10_000 - 700 };
    assert.deepEqual(gate(input('help', reply)), { allow: true });
    assert.equal(gate(input('find a chair', { ...endedAgo(FOUND, 800), segmentStartedAt: 10_000 - 300 })).allow, true);
    assert.equal(gate(input('resume', endedAgo(en.voice.paused(), 800))).allow, true);
  });

  it('without a segment start, falls back to a fixed window after the speech', () => {
    const resume = en.resume('chair');
    assert.deepEqual(gate(input('again', endedAgo(resume, 1000))), { allow: false, reason: 'self-echo' });
    assert.equal(gate(input('again', endedAgo(resume, ECHO.selfEchoWindowMs + 100))).allow, true);
  });

  it('accepts everything when nothing was said recently', () => {
    for (const t of ['find a cup', 'repeat', 'stop', 'pause', 'Hey Navi, what is this']) {
      assert.deepEqual(gate(input(t)), { allow: true }, t);
    }
  });
});

describe('speech state at the start of the segment', () => {
  it('a command begun in silence passes although speech started before its final', () => {
    const late = { ...speaking(en.guide('left')), speakingAtSegmentStart: false, segmentStartedAt: 10_000 - 1300 };
    assert.deepEqual(gate(input('find a cup', late)), { allow: true });
    assert.deepEqual(gate(input('pause', late)), { allow: true });
    // Its echo is still caught by rule 1.
    assert.deepEqual(gate(input('now on the left', late)), { allow: false, reason: 'self-echo' });
    assert.deepEqual(gate(input('I lost sight of the chair', { ...late, currentUtterance: en.lost('chair') })), {
      allow: false,
      reason: 'self-echo',
    });
  });

  it('a command begun over speech is still dropped after the speech ended', () => {
    const begunOver = { ...endedAgo(FOUND, 900), speakingAtSegmentStart: true, segmentStartedAt: 10_000 - 1200 };
    assert.deepEqual(gate(input('find a cup', begunOver)), { allow: false, reason: 'speaking' });
  });
});

describe('barge-in after the echo', () => {
  it('aligns the echo in order and keeps what follows it', () => {
    assert.deepEqual(alignEcho('I found a chair on the left stop', [FOUND]), {
      tail: ['stop'],
      ahead: ['of', 'the', 'camera', 'view'],
    });
    assert.equal(alignEcho('we should stop', [FOUND]), null, 'no echo at all');
    // "say pause ... or repeat" then a second "repeat": only the one out of order is the tail.
    assert.deepEqual(alignEcho('or repeat to end a search say cancel cancel', [HELP])?.tail, []);
  });

  it('finds the barge-in, allowing a couple of misheard words before it', () => {
    assert.deepEqual(bargeInTail('I found a chair on the left stop', [FOUND])?.analysis.command, { type: 'stop' });
    assert.deepEqual(bargeInTail('I found a chair on the left few stop searching', [FOUND])?.analysis.command, {
      type: 'cancel',
    });
    assert.deepEqual(bargeInTail('I found a chair hey navi stop', [FOUND])?.analysis.command, { type: 'stop' });
    assert.equal(bargeInTail('I found a chair on the left I think we should stop', [FOUND]), null, 'too long');
    assert.equal(bargeInTail('I found a chair on the left', [FOUND]), null);
  });

  it('never takes HeyNavi\'s own command words for one', () => {
    const stopSign = en.start('stop sign');
    for (const t of ['looking for a stop', 'looking for a stop sign', 'stop']) {
      assert.equal(bargeInTail(t, [stopSign]), null, t);
    }
    // Echo running ahead of a misheard part: "cancel" is still to be said, so it is not trusted.
    assert.equal(bargeInTail('say find and an object like fine a chair say pause cancel', [HELP]), null);
    // The user's "stop" after the whole stop-sign line is.
    assert.deepEqual(bargeInTail('looking for a stop sign move your phone slowly stop', [stopSign])?.analysis.command, {
      type: 'stop',
    });
  });
});

describe('barge-in before the echo', () => {
  // Heard on the iPhone 16e: the user's word first, then HeyNavi's line in the same segment.
  const LOOKING = en.start('chair');
  const TWO = 'I see two chairs, the largest is on the left.';

  it('finds a command said just before HeyNavi\'s words came back', () => {
    assert.deepEqual(bargeInHead('Cancer the largest is on the left', [TWO])?.analysis.command, { type: 'cancel' });
    assert.deepEqual(bargeInHead('hey navi cancel I see two chairs', [TWO])?.analysis.command, { type: 'cancel' });
  });

  it('keeps a bare "stop" a stop, not "stop looking for" glued to the echo', () => {
    assert.deepEqual(
      bargeInHead('Stop looking for a chair move your phone slowly', [LOOKING])?.analysis.command,
      { type: 'stop' },
    );
  });

  it('ignores HeyNavi\'s own lines that begin like a command', () => {
    assert.equal(bargeInHead('Stop searching', [en.stop()]), null);
    // From the device log: "Stopped searching." then the next search's start line.
    assert.equal(bargeInHead('Stop searching looking for a chair move your phone slowly', [en.stop(), LOOKING]), null);
  });

  it('needs the rest to be mostly HeyNavi\'s words', () => {
    assert.equal(bargeInHead('stop it right now please', [TWO]), null);
    assert.equal(bargeInHead('cancel', [TWO]), null, 'nothing after it: the whole-transcript match handles that');
  });
});
