/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// Drives the listener with a fake recognizer, a manual clock and real phrases.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { phrases } from '../agent/phrases.ts';
import {
  LISTEN,
  actsOnInterim,
  covers,
  createVoiceController,
  type HeardCommand,
  type RecognizerPort,
} from './voice-controller.ts';
import { VOICE } from './voice-session.ts';

const en = phrases('en-US');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { recognizer?: boolean; grant?: boolean } = {}) {
  let time = 0;
  type Timer = { fn: () => void; at: number; every: number | null; cancelled: boolean };
  const timers: Timer[] = [];
  const calls: string[] = [];
  const heard: HeardCommand[] = [];
  const notUnderstood: string[] = [];
  let lost = 0;
  const speech = {
    speaking: false,
    currentText: null as string | null,
    lastText: null as string | null,
    lastEndedAt: null as number | null,
  };
  let throwOnStart = false;
  const recognizer: RecognizerPort = {
    start() {
      calls.push('start');
      if (throwOnStart) throw new Error('audio engine failed');
    },
    abort() {
      calls.push('abort');
    },
    requestPermissions: async () => ({ granted: options.grant ?? true, canAskAgain: true }),
  };
  const add = (fn: () => void, ms: number, every: number | null) => {
    const timer: Timer = { fn, at: time + ms, every, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const cancel = (handle: unknown) => {
    (handle as Timer).cancelled = true;
  };
  const controller = createVoiceController({
    recognizer: options.recognizer === false ? null : recognizer,
    speech,
    now: () => time,
    onCommand: (h) => heard.push(h),
    onNotUnderstood: (t) => notUnderstood.push(t),
    onListeningLost: () => lost++,
    log: () => {},
    setTimer: (fn, ms) => add(fn, ms, null),
    clearTimer: cancel,
    setRepeatingTimer: (fn, ms) => add(fn, ms, ms),
    clearRepeatingTimer: cancel,
  });

  const h = {
    controller,
    calls,
    heard,
    notUnderstood,
    get types() {
      return heard.map((c) => c.command.type);
    },
    get status() {
      return controller.getSnapshot().status;
    },
    get lost() {
      return lost;
    },
    set throwOnStart(value: boolean) {
      throwOnStart = value;
    },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        time = Math.max(time, due.at);
        if (due.every != null) due.at += due.every;
        else due.cancelled = true;
        due.fn();
      }
      time = end;
    },
    speak(text: string) {
      speech.speaking = true;
      speech.currentText = text;
      controller.setSpeaking(true);
    },
    endSpeech() {
      speech.lastText = speech.currentText;
      speech.currentText = null;
      speech.speaking = false;
      speech.lastEndedAt = time;
      controller.setSpeaking(false);
    },
    interim(text: string) {
      controller.handleResult(false, text);
    },
    final(text: string) {
      controller.handleResult(true, text);
    },
    /** Enabled, permitted and listening. */
    async listen() {
      controller.enable();
      await flush();
      controller.handleStart();
      assert.equal(h.status, 'listening');
      return h;
    },
  };
  return h;
}

describe('starting and routing', () => {
  it('asks for permission, starts, and runs a final command', async () => {
    const h = harness();
    h.controller.enable();
    assert.equal(h.status, 'requesting-permission');
    await flush();
    assert.deepEqual(h.calls, ['start']);
    h.controller.handleStart();
    h.advance(1200);
    h.final('Find a chair.');
    assert.deepEqual(h.heard.map((c) => c.command), [{ type: 'find', concept: 'chair', spoken: 'chair' }]);
    assert.equal(h.heard[0].isFinal, true);
    assert.equal(h.heard[0].at, 1200);
    h.controller.shutdown();
  });

  it('acts on a find only once it is final', async () => {
    const h = await harness().listen();
    h.interim('find a');
    h.interim('find a cup');
    assert.deepEqual(h.types, []);
    h.final('find a cup');
    assert.deepEqual(h.types, ['find']);
    h.controller.shutdown();
  });

  it('cuts speech off on an interim "stop", and does not run it again for its final', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('stop');
    assert.deepEqual(h.types, ['quiet'], 'an interim barge-in only silences');
    assert.equal(h.heard[0].isFinal, false);
    assert.equal(h.heard[0].transcript, 'stop');
    h.interim('stop');
    h.endSpeech();
    h.final('stop');
    assert.deepEqual(h.types, ['quiet']);
    h.controller.shutdown();
  });

  // Seen on the iPhone 16e: the final of a barge-in "stop" came after a segment reset, so it
  // looked like a "stop" said in silence and ended the search the user only meant to quiet.
  for (const reset of ['nomatch', 'empty final'] as const) {
    it(`does not end the search with the final of a barge-in "stop" after a ${reset}`, async () => {
      const h = await harness().listen();
      h.speak(en.found('chair', 'left', null));
      h.interim(' Stop');
      assert.deepEqual(h.types, ['quiet']);
      h.advance(10);
      h.endSpeech();
      if (reset === 'nomatch') h.controller.handleNoMatch();
      else h.final('');
      h.advance(900);
      h.final(' Stop');
      assert.deepEqual(h.types, ['quiet'], 'the final "stop" is the same word that cut the speech');
      h.controller.shutdown();
    });
  }

  it('a second "stop" after a barge-in follow window ends the search', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('stop');
    h.endSpeech();
    h.final('stop');
    h.advance(LISTEN.bargeInFollowMs + 100);
    h.interim('stop');
    h.final('stop');
    assert.deepEqual(h.types, ['quiet', 'stop']);
    h.controller.shutdown();
  });

  it('waits for the final on a bare "stop" while HeyNavi is silent', async () => {
    const h = await harness().listen();
    h.interim('stop');
    assert.deepEqual(h.types, []);
    h.interim('stop talking');
    h.final('stop talking');
    assert.deepEqual(h.types, ['quiet']);
    h.controller.shutdown();
  });

  it('an early "stop" does not swallow a final "stop searching"', async () => {
    const h = await harness().listen();
    h.speak(en.coaching('chair', 0));
    h.interim('stop');
    h.endSpeech();
    h.final('stop searching');
    assert.deepEqual(h.types, ['quiet', 'cancel']);
    h.controller.shutdown();
  });

  it('"cancel" while silent waits for the final', async () => {
    const h = await harness().listen();
    h.interim('never mind');
    assert.deepEqual(h.types, []);
    h.final('never mind');
    assert.deepEqual(h.types, ['cancel']);
    h.controller.shutdown();
  });

  it('does not end the search for a sentence that only begins like cancel', async () => {
    const h = await harness().listen();
    for (const [interim, final] of [
      ['stop looking', 'stop looking at me'],
      ['never mind', 'never mind I see it'],
      ['cancel', 'cancel the meeting'],
      ['forget it', "forget it I'll do it later"],
      ['stop searching', 'stop searching your bag'],
    ]) {
      h.interim(interim);
      h.final(final);
      h.advance(2000);
    }
    assert.deepEqual(h.types, []);
    // A correction keeps its new request.
    h.interim('never mind');
    h.final('never mind find the door instead');
    assert.deepEqual(h.heard.map((c) => c.command), [{ type: 'find', concept: 'door', spoken: 'door' }]);
    h.controller.shutdown();
  });

  it('while speaking, an interim cancel silences and its final still ends the search', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('never mind');
    assert.deepEqual(h.types, ['quiet']);
    h.endSpeech();
    h.final('never mind');
    assert.deepEqual(h.types, ['quiet', 'cancel']);
    h.controller.shutdown();
  });

  it('does not hear its own "Stopped searching." as a cancel', async () => {
    const h = await harness().listen();
    h.speak(en.stop());
    h.interim('stop searching');
    h.endSpeech();
    h.advance(600);
    h.final('stop searching');
    assert.deepEqual(h.types, []);
    h.controller.shutdown();
  });

  it('drops the commands named in the help line while it plays', async () => {
    const h = await harness().listen();
    h.speak(en.voice.help());
    for (const clause of [
      'say find and an object',
      'like find a chair',
      'say pause',
      'resume',
      'or repeat',
      'to end the search',
      'say cancel',
      'cancel',
    ]) {
      h.interim(clause);
      h.final(clause);
    }
    // The whole line as one segment.
    h.interim('say find and an object like find a chair say pause resume or repeat to end the search say cancel');
    h.endSpeech();
    // A late final of the last clause, finalized after the line ended.
    h.interim('cancel');
    h.advance(700);
    h.final('cancel');
    assert.deepEqual(h.types, []);
    h.controller.shutdown();
  });

  it('"stop" cuts the help line off, alone or after its echo', async () => {
    const h = await harness().listen();
    h.speak(en.voice.help());
    h.interim('stop');
    assert.deepEqual(h.types, ['quiet']);
    h.controller.shutdown();

    const echo = await harness().listen();
    echo.speak(en.voice.help());
    echo.interim('say find and an object like find a chair say pause resume or repeat stop');
    assert.deepEqual(echo.types, ['quiet']);
    echo.controller.shutdown();
  });

  it('accepts "help" said in reply to "Say help to hear what I can do"', async () => {
    const h = await harness().listen();
    h.speak(en.voice.notUnderstood());
    h.endSpeech();
    h.advance(600);
    h.interim('help');
    h.advance(600);
    h.final('help');
    assert.deepEqual(h.types, ['help']);
    h.controller.shutdown();
  });

  it('ignores the same command again within the debounce window', async () => {
    const h = await harness().listen();
    h.final('repeat');
    h.advance(LISTEN.debounceMs - 100);
    h.final('repeat');
    assert.deepEqual(h.types, ['repeat']);
    h.advance(200);
    h.final('repeat');
    assert.deepEqual(h.types, ['repeat', 'repeat']);
    h.controller.shutdown();
  });

  it('answers unknown speech only when it started with "Hey Navi"', async () => {
    const h = await harness().listen();
    h.final('play some music');
    assert.deepEqual(h.notUnderstood, [], 'bystander speech is ignored');
    h.final('hey navi');
    assert.deepEqual(h.notUnderstood, [], 'the wake phrase alone waits for more');
    h.final('Hey Navi, play some music');
    assert.deepEqual(h.notUnderstood, ['Hey Navi, play some music']);
    h.advance(1000);
    h.final('Hey Navi, blah blah');
    assert.equal(h.notUnderstood.length, 1, 'not again right away');
    h.speak(en.start('chair'));
    h.advance(LISTEN.notUnderstoodMinIntervalMs);
    h.final('Hey Navi, blah blah');
    assert.equal(h.notUnderstood.length, 1, 'not while HeyNavi speaks');
    h.controller.shutdown();
  });

  it('ignores results while listening is off', async () => {
    const h = await harness().listen();
    h.controller.disable();
    h.final('find a chair');
    assert.deepEqual(h.types, []);
    h.controller.shutdown();
  });
});

describe('restarts and watchdog', () => {
  it('restarts after an unplanned end, with back-off', async () => {
    const h = await harness().listen();
    h.controller.handleError('audio-capture', 'engine failed');
    h.controller.handleEnd();
    assert.equal(h.status, 'restarting');
    h.advance(249);
    assert.deepEqual(h.calls, ['start']);
    h.advance(1);
    assert.deepEqual(h.calls, ['start', 'start']);
    h.controller.shutdown();
  });

  it('keeps a session that sends volume events, and restarts one that stalls', async () => {
    const h = await harness().listen();
    for (let i = 0; i < 20; i++) {
      h.advance(300);
      h.controller.handleVolume();
    }
    assert.deepEqual(h.calls, ['start']);
    h.advance(VOICE.stallMs + 500);
    assert.deepEqual(h.calls, ['start', 'abort']);
    h.controller.handleError('aborted', 'Speech recognition aborted.');
    h.controller.handleEnd();
    h.advance(VOICE.afterAbortMs);
    assert.deepEqual(h.calls, ['start', 'abort', 'start']);
    assert.equal(h.status, 'starting');
    h.controller.shutdown();
  });

  it('does not restart while HeyNavi speaks, and re-arms when it stops', async () => {
    const h = await harness().listen();
    h.speak(en.checkIn('chair'));
    h.advance(10_000);
    assert.deepEqual(h.calls, ['start']);
    h.endSpeech();
    h.advance(VOICE.stallMs - 600);
    assert.deepEqual(h.calls, ['start']);
    h.advance(1000);
    assert.deepEqual(h.calls, ['start', 'abort']);
    h.controller.shutdown();
  });

  it('retries when start() throws', async () => {
    const h = harness();
    h.throwOnStart = true;
    h.controller.enable();
    await flush();
    h.advance(0);
    assert.equal(h.status, 'restarting');
    h.throwOnStart = false;
    h.advance(250);
    assert.deepEqual(h.calls, ['start', 'start']);
    assert.equal(h.status, 'starting');
    h.controller.shutdown();
  });

  it('stops in the background and starts again in the foreground', async () => {
    const h = await harness().listen();
    h.controller.setForeground(false);
    assert.deepEqual(h.calls, ['start', 'abort']);
    h.controller.handleError('aborted', 'Speech recognition aborted.');
    h.controller.handleEnd();
    h.advance(5000);
    assert.deepEqual(h.calls, ['start', 'abort'], 'nothing runs in the background');
    h.controller.setForeground(true);
    assert.deepEqual(h.calls, ['start', 'abort', 'start']);
    h.controller.shutdown();
  });

  it('reports a missing recognizer instead of failing', () => {
    const h = harness({ recognizer: false });
    h.controller.enable();
    assert.equal(h.status, 'error');
    assert.equal(h.controller.getSnapshot().error, 'not-supported');
    h.controller.shutdown();
  });

  it('ignores a permission answer that arrives after unmount', async () => {
    const h = harness();
    h.controller.enable();
    h.controller.shutdown();
    await flush();
    assert.deepEqual(h.calls, ['abort'], 'the unmount abort only; nothing starts');
    assert.equal(h.status, 'off');
  });
});

describe('interim rules', () => {
  it('acts early only on a barge-in while HeyNavi speaks', () => {
    for (const type of ['stop', 'cancel', 'quiet'] as const) {
      assert.equal(actsOnInterim({ type }, true), true, type);
      assert.equal(actsOnInterim({ type }, false), false, type);
    }
    assert.equal(actsOnInterim({ type: 'repeat' }, true), false);
  });

  it('knows which later command an earlier one already covered', () => {
    assert.equal(covers({ type: 'stop' }, { type: 'quiet' }), true);
    assert.equal(covers({ type: 'stop' }, { type: 'cancel' }), false);
    assert.equal(covers({ type: 'cancel' }, { type: 'stop' }), true);
    assert.equal(covers({ type: 'repeat' }, { type: 'help' }), false);
    assert.equal(covers({ type: 'quiet' }, { type: 'stop' }), true, 'stop said over speech');
    assert.equal(covers({ type: 'quiet' }, { type: 'stop' }, false), false, 'stop said in silence ends the search');
  });
});

describe('barge-in over the echo of HeyNavi\'s speech', () => {
  it('hears "stop" after HeyNavi\'s own words in the same segment', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('I found a chair on the left');
    assert.deepEqual(h.types, [], 'the echo alone does nothing');
    h.interim('I found a chair on the left stop');
    assert.deepEqual(h.types, ['quiet']);
    h.interim('I found a chair on the left stop stop');
    h.final('I found a chair on the left stop');
    assert.deepEqual(h.types, ['quiet'], 'once');
    h.controller.shutdown();
  });

  // The iPhone 16e sequence: "Cancer" (= cancel) cuts the speech at once, then its final also
  // holds the echo that followed it. The final must still end the search.
  it('hears "cancel" said just before HeyNavi\'s words came back', async () => {
    const h = await harness().listen();
    const two = en.foundMany('chair', 2, 'left', null);
    h.speak(two);
    h.interim('Cancer');
    assert.deepEqual(h.types, ['quiet']);
    h.endSpeech();
    h.advance(600);
    h.final('Cancer the largest is on the left');
    assert.deepEqual(h.types, ['quiet', 'cancel']);
    h.controller.shutdown();
  });

  it('a "stop" before the echo still only silences', async () => {
    const h = await harness().listen();
    const start = en.start('chair');
    h.speak(start);
    h.final(`Stop ${start}`);
    assert.deepEqual(h.types, ['stop']);
    assert.equal(h.heard[0].speakingAtStart, true, 'so voice-actions only silences the speech');
    h.controller.shutdown();
  });

  it('hears a barge-in after a misheard echo, and one with the wake phrase', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('I found a chair on the left of the camera few stop');
    assert.deepEqual(h.types, ['quiet']);
    h.endSpeech();
    h.final('I found a chair on the left of the camera few stop searching');
    assert.deepEqual(h.types, ['quiet', 'cancel']);
    h.advance(2000);
    h.speak(en.coaching('cup', 1));
    h.interim('still looking for a cup hey navi be quiet');
    assert.deepEqual(h.types, ['quiet', 'cancel', 'quiet']);
    h.controller.shutdown();
  });

  it('hears a command said right after a line ended, before the segment ended', async () => {
    const h = await harness().listen();
    h.speak(en.guide('left'));
    h.interim('now on the left');
    h.endSpeech();
    h.advance(300);
    h.final('now on the left stop');
    // Begun over speech: "stop" means "stop talking", and the line is already over.
    assert.deepEqual(h.types, ['stop']);
    assert.equal(h.heard[0].speakingAtStart, true);
    h.controller.shutdown();
  });

  it('does not take a command word HeyNavi itself says for a barge-in', async () => {
    const h = await harness().listen();
    h.speak(en.start('stop sign'));
    h.interim('looking for a stop');
    h.interim('looking for a stop sign move your phone slowly');
    h.endSpeech();
    h.final('looking for a stop sign move your phone slowly');
    h.advance(2000);
    h.speak(en.stop());
    h.interim('stopped');
    h.interim('stopped searching');
    h.final('stopped searching');
    assert.deepEqual(h.types, []);
    h.controller.shutdown();
  });

  it('ignores a sentence that only ends in "stop" when no echo comes first', async () => {
    const h = await harness().listen();
    h.speak(en.found('chair', 'left', null));
    h.interim('we should stop');
    assert.deepEqual(h.types, []);
    h.controller.shutdown();
  });
});

describe('what the user meant is judged when they began', () => {
  it('a command said in silence is not dropped because a guidance line started before its final', async () => {
    const h = await harness().listen();
    h.interim('find a');
    h.advance(300);
    h.interim('find a cup');
    h.advance(700);
    h.speak(en.guide('left'));
    h.advance(300);
    h.final('find a cup');
    assert.deepEqual(h.types, ['find']);
    assert.equal(h.heard[0].speakingAtStart, false);
    h.controller.shutdown();
  });

  it('"stop" said in silence keeps its meaning when speech starts before its final', async () => {
    const h = await harness().listen();
    h.advance(1000);
    h.interim('stop');
    assert.deepEqual(h.types, [], 'nothing to cut off yet');
    h.advance(500);
    h.speak(en.guide('left'));
    h.interim('stop');
    assert.deepEqual(h.types, ['quiet'], 'the new line is cut off at once');
    h.advance(400);
    h.final('stop');
    assert.deepEqual(h.types, ['quiet', 'stop'], 'and the final still ends the search');
    assert.equal(h.heard[1].speakingAtStart, false);
    h.controller.shutdown();
  });
});

describe('segments', () => {
  it('a segment that ended without words ("nomatch") does not leak into the next one', async () => {
    const h = await harness().listen();
    h.speak(en.voice.notUnderstood());
    h.interim('say help');
    h.endSpeech();
    h.controller.handleNoMatch();
    h.advance(1500);
    h.interim('help');
    h.advance(600);
    h.final('help');
    assert.deepEqual(h.types, ['help']);
    h.controller.shutdown();
  });
});

describe('recovering', () => {
  it('says once that listening stopped, and retries when the app is active again', async () => {
    const h = await harness().listen();
    for (let i = 0; i < 5; i++) {
      h.controller.handleError('audio-capture', 'engine failed');
      h.controller.handleEnd();
      // Past the back-off (250 ms up to 2 s), within the stall window.
      h.advance(2100);
      if (i < 4) assert.equal(h.status, 'starting');
    }
    assert.equal(h.status, 'error');
    assert.equal(h.lost, 1);
    h.controller.handleError('aborted', 'Speech recognition aborted.');
    h.controller.handleEnd();
    h.controller.retry();
    assert.equal(h.status, 'starting');
    h.controller.handleError('audio-capture', 'engine failed');
    h.controller.handleEnd();
    assert.equal(h.lost, 1, 'not again until a result proved it works');
    h.controller.shutdown();
  });
});

/**
 * A fake recognizer that sends events like expo-speech-recognition on iOS: start() on a live
 * task first ends it ("end"); abort() always sends "error aborted" and then "end", even with no
 * task; a task ending on its own sends its error and "end". Events arrive later (deliver()).
 */
function nativeLike() {
  let time = 0;
  const queue: (() => void)[] = [];
  let taskAlive = false;
  let aborts = 0;
  type Timer = { fn: () => void; at: number; every: number | null; cancelled: boolean };
  const timers: Timer[] = [];
  const add = (fn: () => void, ms: number, every: number | null) => {
    const timer: Timer = { fn, at: time + ms, every, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const speech = { speaking: false, currentText: null, lastText: null, lastEndedAt: null };
  const recognizer: RecognizerPort = {
    start() {
      if (taskAlive) queue.push(() => controller.handleEnd());
      taskAlive = true;
      queue.push(() => controller.handleStart());
    },
    abort() {
      aborts++;
      taskAlive = false;
      queue.push(() => controller.handleError('aborted', 'Speech recognition aborted.'));
      queue.push(() => controller.handleEnd());
    },
    requestPermissions: async () => ({ granted: true, canAskAgain: true }),
  };
  const controller = createVoiceController({
    recognizer,
    speech,
    now: () => time,
    onCommand: () => {},
    onNotUnderstood: () => {},
    log: () => {},
    setTimer: (fn, ms) => add(fn, ms, null),
    clearTimer: (t) => ((t as Timer).cancelled = true),
    setRepeatingTimer: (fn, ms) => add(fn, ms, ms),
    clearRepeatingTimer: (t) => ((t as Timer).cancelled = true),
  });
  return {
    controller,
    get taskAlive() {
      return taskAlive;
    },
    get aborts() {
      return aborts;
    },
    /** The task ends on its own (e.g. "network"); its events are queued. */
    naturalEnd(code: 'network' | 'no-speech') {
      taskAlive = false;
      queue.push(() => controller.handleError(code, code));
      queue.push(() => controller.handleEnd());
    },
    deliver() {
      while (queue.length > 0) queue.shift()!();
    },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        time = Math.max(time, due.at);
        if (due.every != null) due.at += due.every;
        else due.cancelled = true;
        due.fn();
        this.deliver();
      }
      time = end;
    },
  };
}

describe('with native-like "end" events', () => {
  it('a natural end crossing the watchdog abort leaves one live, tracked session', async () => {
    const n = nativeLike();
    n.controller.enable();
    await flush();
    n.deliver();
    assert.equal(n.controller.getSnapshot().status, 'listening');
    // No events for the stall window: the watchdog aborts, and the task ends on its own too.
    n.advance(VOICE.stallMs);
    n.naturalEnd('network');
    n.deliver();
    n.advance(5000);
    const state = n.controller.getSnapshot();
    assert.equal(state.status, 'listening');
    assert.equal(state.native, true);
    assert.equal(n.taskAlive, true);
    assert.equal(state.error, null);
    n.controller.shutdown();
    n.deliver();
    assert.equal(n.taskAlive, false, 'the microphone is off after unmount');
  });

  it('the same race with the natural end arriving first', async () => {
    const n = nativeLike();
    n.controller.enable();
    await flush();
    n.deliver();
    n.advance(VOICE.stallMs - 1);
    // Queued before the watchdog's abort: "network", "end", then "aborted", "end".
    n.naturalEnd('network');
    n.advance(5000);
    const state = n.controller.getSnapshot();
    assert.equal(state.status, 'listening');
    assert.equal(state.native, true);
    assert.equal(n.taskAlive, true);
    n.controller.shutdown();
    n.deliver();
    assert.equal(n.taskAlive, false);
  });

  it('shutdown aborts the native task even when the reducer thinks none runs', async () => {
    const n = nativeLike();
    n.controller.enable();
    await flush();
    n.deliver();
    // The session ends on its own; a restart is pending when the screen goes away.
    n.naturalEnd('no-speech');
    n.deliver();
    assert.equal(n.controller.getSnapshot().native, false);
    n.controller.shutdown();
    assert.equal(n.aborts, 1);
  });
});
