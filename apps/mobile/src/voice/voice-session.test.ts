/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VOICE,
  initialVoiceState,
  micStatus,
  reduceVoice,
  shouldRun,
  voiceLabel,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from './voice-session.ts';

/** Feeds events at given times and keeps the latest state and effects. */
function session(initial: VoiceState = initialVoiceState()) {
  let state = initial;
  let effects: VoiceEffect[] = [];
  const s = {
    get state() {
      return state;
    },
    get effects() {
      return effects.map((e) => e.type);
    },
    send(event: VoiceEvent, now = 0) {
      const t = reduceVoice(state, event, now);
      state = t.state;
      effects = t.effects;
      return s;
    },
  };
  return s;
}

/** Enabled, permitted and listening since t=0. */
function listening() {
  return session()
    .send({ type: 'enable' })
    .send({ type: 'permission', granted: true, canAskAgain: true })
    .send({ type: 'native-start' });
}

/** What the native module sends for one abort() call: "error aborted", then "end". */
const ABORTED: VoiceEvent = { type: 'native-error', code: 'aborted' };
const END: VoiceEvent = { type: 'native-end' };

describe('starting', () => {
  it('asks for permission, then starts and listens', () => {
    const s = session().send({ type: 'enable' });
    assert.equal(s.state.status, 'requesting-permission');
    assert.deepEqual(s.effects, ['request-permission']);
    assert.equal(micStatus(s.state), 'asking');

    s.send({ type: 'permission', granted: true, canAskAgain: true });
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
    assert.equal(shouldRun(s.state), true);

    s.send({ type: 'native-start' });
    assert.equal(s.state.status, 'listening');
    assert.equal(voiceLabel(s.state), 'Listening');
  });

  it('does not ask twice while the prompt is up', () => {
    const s = session().send({ type: 'enable' }).send({ type: 'enable' });
    assert.deepEqual(s.effects, []);
  });

  it('a first result also counts as started', () => {
    const s = session()
      .send({ type: 'enable' })
      .send({ type: 'permission', granted: true, canAskAgain: true })
      .send({ type: 'result' });
    assert.equal(s.state.status, 'listening');
  });
});

describe('permission', () => {
  it('a denial is an error the user can see and retry', () => {
    const s = session().send({ type: 'enable' }).send({ type: 'permission', granted: false, canAskAgain: false });
    assert.equal(s.state.status, 'error');
    assert.equal(s.state.error, 'permission-denied');
    assert.equal(s.state.canAskAgain, false);
    assert.equal(micStatus(s.state), 'needs-permission');
    assert.equal(voiceLabel(s.state), 'Needs microphone permission');
    assert.equal(shouldRun(s.state), false);

    // Tapping the mic button (or coming back from Settings) asks again.
    s.send({ type: 'enable' });
    assert.equal(s.state.status, 'requesting-permission');
    assert.deepEqual(s.effects, ['request-permission']);
  });

  it('coming back to the app re-checks a denied permission', () => {
    const s = session().send({ type: 'enable' }).send({ type: 'permission', granted: false, canAskAgain: false });
    s.send({ type: 'app-state', active: false }).send({ type: 'app-state', active: true });
    assert.equal(s.state.status, 'requesting-permission');
    s.send({ type: 'permission', granted: true, canAskAgain: true });
    assert.equal(s.state.status, 'starting');
  });

  it('"not-allowed" from the recognizer means the permission was taken away', () => {
    const s = listening().send({ type: 'native-error', code: 'not-allowed' });
    assert.equal(s.state.error, 'permission-denied');
    assert.deepEqual(s.effects, ['cancel-restart', 'abort']);
    s.send({ type: 'native-end' });
    assert.equal(s.state.status, 'error');
    assert.deepEqual(s.effects, []);
  });

  it('a missing locale or recognizer is permanent', () => {
    const s = listening().send({ type: 'native-error', code: 'language-not-supported' });
    assert.equal(s.state.error, 'not-supported');
    s.send({ type: 'native-end' }).send({ type: 'enable' });
    assert.equal(s.state.error, 'not-supported');
    assert.equal(voiceLabel(s.state), 'Voice commands unavailable');
  });

  it('reports a missing native module', () => {
    const s = session().send({ type: 'enable' }).send({ type: 'unsupported' });
    assert.equal(s.state.status, 'error');
    assert.equal(micStatus(s.state), 'unavailable');
  });
});

describe('restarts', () => {
  it('restarts quickly after a long session ended on silence', () => {
    const s = listening().send({ type: 'native-error', code: 'no-speech' }, 30_000);
    const t = reduceVoice(s.state, { type: 'native-end' }, 30_000);
    assert.deepEqual(t.effects, [{ type: 'schedule-restart', delayMs: 250 }]);
    s.send({ type: 'native-end' }, 30_000);
    assert.equal(s.state.status, 'restarting');
    assert.equal(micStatus(s.state), 'listening', 'no flicker in the indicator');
    s.send({ type: 'restart-due' }, 30_250);
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
  });

  it('backs off on repeated failures and gives up after the streak limit', () => {
    const s = listening();
    const delays: number[] = [];
    let now = 0;
    while (s.state.status !== 'error' && delays.length < 10) {
      s.send({ type: 'native-error', code: 'audio-capture' }, now);
      const t = reduceVoice(s.state, { type: 'native-end' }, now + 10);
      s.send({ type: 'native-end' }, now + 10);
      for (const effect of t.effects) {
        if (effect.type === 'schedule-restart') delays.push(effect.delayMs);
      }
      if (s.state.status === 'restarting') s.send({ type: 'restart-due' }, now + 20);
      now += 100;
    }
    assert.deepEqual(delays, [250, 500, 1000, 2000, VOICE.retryAfterErrorMs]);
    assert.equal(s.state.error, 'gave-up');
    assert.equal(voiceLabel(s.state), 'Mic stopped after errors');
    // abort() anyway (a session may still be recording), and try again later on its own.
    assert.deepEqual(s.effects, ['cancel-restart', 'schedule-restart', 'abort']);

    // The user can try again.
    s.send(ABORTED).send(END).send({ type: 'enable' });
    assert.equal(s.state.status, 'starting');
    assert.equal(s.state.streak, 0);
  });

  it('emits the back-off delay with the restart', () => {
    const s = listening().send({ type: 'native-error', code: 'busy' }, 10);
    const t = reduceVoice(s.state, { type: 'native-end' }, 20);
    assert.deepEqual(t.effects, [{ type: 'schedule-restart', delayMs: 1000 }]);
  });

  it('a result resets the back-off', () => {
    const s = listening().send({ type: 'native-error', code: 'audio-capture' }).send({ type: 'native-end' }, 10);
    s.send({ type: 'restart-due' }, 300).send({ type: 'native-start' }, 310);
    assert.equal(s.state.attempt, 1);
    s.send({ type: 'result' }, 400);
    assert.equal(s.state.attempt, 0);
    assert.equal(s.state.streak, 0);
  });

  it('ignores the "aborted" error of its own abort', () => {
    const s = listening().send({ type: 'disable' });
    assert.equal(s.state.abortRequested, true);
    assert.equal(s.state.abortsPending, 1);
    s.send(ABORTED);
    assert.equal(s.state.session.error, null, 'not a failure');
    assert.equal(s.state.abortAcks, 1, 'its "end" comes next');
    assert.deepEqual(s.effects, []);
    s.send(END);
    assert.equal(s.state.abortsPending, 0);
    assert.equal(s.state.native, false);
  });

  it('start() throwing is handled like a failed session', () => {
    const s = session()
      .send({ type: 'enable' })
      .send({ type: 'permission', granted: true, canAskAgain: true })
      .send({ type: 'start-failed' }, 5);
    assert.equal(s.state.status, 'restarting');
    assert.equal(s.state.streak, 1);
    assert.deepEqual(s.effects, ['schedule-restart']);
  });
});

describe('watchdog', () => {
  it('aborts a stalled session and starts again shortly after its end', () => {
    const s = listening().send({ type: 'stall' }, 3000);
    assert.equal(s.state.status, 'restarting');
    assert.deepEqual(s.effects, ['abort', 'schedule-restart']);
    s.send(ABORTED, 3010);
    const t = reduceVoice(s.state, END, 3020);
    assert.deepEqual(t.effects, [{ type: 'schedule-restart', delayMs: VOICE.afterAbortMs }]);
    s.send(END, 3020);
    assert.equal(s.state.status, 'restarting');
    s.send({ type: 'restart-due' }, 3020 + VOICE.afterAbortMs);
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
  });

  it('starts anyway when the aborted session never ends', () => {
    const s = listening().send({ type: 'stall' }, 3000).send({ type: 'restart-due' }, 3000 + VOICE.stallFallbackMs);
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
  });

  it('never restarts while HeyNavi is speaking', () => {
    const s = listening().send({ type: 'tts', speaking: true });
    const before = s.state;
    s.send({ type: 'stall' });
    assert.equal(s.state, before);
  });
});

describe('pausing', () => {
  it('stops in the background and comes back in the foreground', () => {
    const s = listening().send({ type: 'app-state', active: false });
    assert.equal(s.state.status, 'paused');
    assert.equal(s.state.pausedBy, 'background');
    assert.deepEqual(s.effects, ['cancel-restart', 'abort']);
    assert.equal(voiceLabel(s.state), 'Paused');

    s.send({ type: 'native-error', code: 'aborted' }).send({ type: 'native-end' });
    assert.equal(s.state.status, 'paused', 'no restart in the background');
    assert.deepEqual(s.effects, ['cancel-restart']);

    s.send({ type: 'app-state', active: true });
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
  });

  it('a pending restart is cancelled in the background', () => {
    const s = listening().send({ type: 'native-end' }, 30_000).send({ type: 'app-state', active: false });
    assert.equal(s.state.status, 'paused');
    assert.deepEqual(s.effects, ['cancel-restart']);
    s.send({ type: 'restart-due' });
    assert.equal(s.state.status, 'paused');
  });

  it('returning before the abort finished starts once the end arrives', () => {
    const s = listening().send({ type: 'app-state', active: false }).send({ type: 'app-state', active: true });
    assert.equal(s.state.status, 'restarting');
    assert.deepEqual(s.effects, ['schedule-restart'], 'a fallback, in case the end never comes');
    s.send(ABORTED).send(END);
    assert.equal(s.state.status, 'restarting');
    s.send({ type: 'restart-due' });
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
  });

  it('the mic toggle pauses and resumes listening', () => {
    const s = listening().send({ type: 'disable' });
    assert.equal(s.state.status, 'paused');
    assert.equal(s.state.pausedBy, 'user');
    assert.equal(voiceLabel(s.state), 'Mic off');
    s.send(ABORTED).send(END).send({ type: 'app-state', active: false }).send({ type: 'app-state', active: true });
    assert.equal(s.state.status, 'paused', 'coming back does not undo the toggle');
    s.send({ type: 'enable' });
    assert.equal(s.state.status, 'starting');
  });

  it('shuts down to off, and can be enabled again', () => {
    const s = listening().send({ type: 'shutdown' });
    assert.equal(s.state.status, 'off');
    assert.deepEqual(s.effects, ['cancel-restart', 'abort']);
    s.send(ABORTED).send(END).send({ type: 'enable' });
    assert.equal(s.state.status, 'starting');
  });

  it('shutdown aborts even when no session is known to run', () => {
    // A restart is pending (the last session ended); a native session may still be alive.
    const s = listening().send(END, 30_000);
    assert.equal(s.state.native, false);
    s.send({ type: 'shutdown' });
    assert.equal(s.state.status, 'off');
    assert.deepEqual(s.effects, ['cancel-restart', 'abort']);
  });
});

describe('extra "end" events (native sends one per abort, even after a natural end)', () => {
  it('a natural end that crosses the watchdog abort is not credited to the next session', () => {
    // The stall abort at 3500 ms meets the session ending on its own at 3501 ms.
    const s = listening().send({ type: 'stall' }, 3500);
    s.send({ type: 'native-error', code: 'network' }, 3501).send(END, 3501);
    assert.equal(s.state.status, 'restarting');
    assert.equal(s.state.native, false);
    assert.deepEqual(s.effects, [], 'nothing starts while the abort is unanswered');
    // Its "aborted" and "end" follow: now it may start.
    s.send(ABORTED, 3502).send(END, 3502);
    assert.deepEqual(s.effects, ['schedule-restart']);
    s.send({ type: 'restart-due' }, 3502 + VOICE.afterAbortMs).send({ type: 'native-start' }, 3700);
    assert.equal(s.state.status, 'listening');
    assert.equal(s.state.native, true);
    assert.equal(s.state.streak, 1, 'only the stall counts, not the crossing end');
  });

  it('a late "end" right after an aborted session\'s end lands in the restart delay', () => {
    // "aborted", then two "end"s (the session's own and the abort's) in either order.
    const s = listening().send({ type: 'stall' }, 3500).send(ABORTED, 3501).send(END, 3501).send(END, 3502);
    assert.equal(s.state.status, 'restarting');
    s.send({ type: 'restart-due' }, 3501 + VOICE.afterAbortMs);
    assert.equal(s.state.status, 'starting');
    s.send({ type: 'native-start' }, 3700);
    assert.equal(s.state.status, 'listening');
  });

  it('the end of an abort given up on by the fallback start is ignored', () => {
    const s = listening().send({ type: 'stall' }, 3000).send({ type: 'restart-due' }, 3000 + VOICE.stallFallbackMs);
    assert.equal(s.state.status, 'starting');
    s.send({ type: 'native-start' }, 4100);
    // The old abort is answered at last.
    s.send(ABORTED, 4200).send(END, 4200);
    assert.equal(s.state.status, 'listening');
    assert.equal(s.state.native, true);
    s.send({ type: 'shutdown' }, 5000);
    assert.deepEqual(s.effects, ['cancel-restart', 'abort'], 'and the live session is aborted on unmount');
  });
});

describe('audio interruptions (Siri, a call, an alarm)', () => {
  /** "interrupted", then every restart fails at once with audio-capture. */
  function interrupted() {
    const s = listening().send({ type: 'native-error', code: 'interrupted' }, 5001).send(END, 5001);
    assert.equal(s.state.status, 'restarting');
    let now = 5001;
    for (let i = 0; i < 8; i++) {
      now += VOICE.interruptedRetryMs;
      s.send({ type: 'restart-due' }, now);
      assert.equal(s.state.status, 'starting');
      s.send({ type: 'native-error', code: 'audio-capture' }, now + 5).send(END, now + 6);
    }
    return { s, now };
  }

  it('retries slowly without giving up while the audio session is taken', () => {
    const { s } = interrupted();
    assert.equal(s.state.status, 'restarting');
    assert.equal(s.state.error, null);
    assert.equal(s.state.streak, 0);
    assert.equal(micStatus(s.state), 'listening');
  });

  it('restarts at once when the app becomes active again, also from inactive', () => {
    const { s, now } = interrupted();
    s.send({ type: 'retry' }, now + 100);
    assert.equal(s.state.status, 'starting');
    assert.deepEqual(s.effects, ['cancel-restart', 'start']);
    s.send({ type: 'native-start' }, now + 200);
    assert.equal(s.state.interrupted, false, 'over once the engine runs');
  });

  it('a session that started ends the interruption: later failures count again', () => {
    const { s, now } = interrupted();
    s.send({ type: 'retry' }, now).send({ type: 'native-start' }, now + 10);
    s.send({ type: 'native-error', code: 'audio-capture' }, now + 20).send(END, now + 30);
    assert.equal(s.state.streak, 1);
  });
});

describe('retrying after errors', () => {
  function gaveUp() {
    const s = listening();
    let now = 0;
    while (s.state.status !== 'error') {
      s.send({ type: 'native-error', code: 'audio-capture' }, now).send(END, now + 10);
      if (s.state.status === 'restarting') s.send({ type: 'restart-due' }, now + 20);
      now += 100;
    }
    s.send(ABORTED, now).send(END, now);
    return { s, now };
  }

  it('after giving up, tries again on its own after a while', () => {
    const { s, now } = gaveUp();
    assert.equal(s.state.error, 'gave-up');
    s.send({ type: 'restart-due' }, now + VOICE.retryAfterErrorMs);
    assert.equal(s.state.status, 'starting');
    assert.equal(s.state.streak, 0);
  });

  it('coming back from inactive retries a listener that gave up', () => {
    const { s, now } = gaveUp();
    s.send({ type: 'retry' }, now + 10);
    assert.equal(s.state.status, 'starting');
  });

  it('a retry does not re-ask a denied permission, and does nothing while listening', () => {
    const denied = session().send({ type: 'enable' }).send({ type: 'permission', granted: false, canAskAgain: false });
    denied.send({ type: 'retry' });
    assert.equal(denied.state.error, 'permission-denied');
    const live = listening();
    const before = live.state;
    live.send({ type: 'retry' });
    assert.equal(live.state, before);
  });

  it('"service-not-allowed" (model download, Dictation off) is retried, not permanent', () => {
    const s = listening().send({ type: 'native-error', code: 'service-not-allowed' }, 10).send(END, 20);
    assert.equal(s.state.status, 'restarting');
    assert.equal(s.state.error, null);
    assert.equal(micStatus(s.state), 'listening');
  });
});
