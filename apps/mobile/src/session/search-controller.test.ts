/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// Drives the real loop with a fake camera, backend, speaker and haptics (no Meta calls).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Speaker } from '../agent/announcer.ts';
import { det } from '../agent/test-helpers.ts';
import type { Detection } from '../agent/types.ts';
import type { DetectRequest, DetectResult } from '../api/detect-response.ts';
import { METRICS_TAG } from './metrics.ts';
import { createSearchController, type ControllerDeps } from './search-controller.ts';

type Responder = (request: DetectRequest, signal: AbortSignal) => Promise<DetectResult>;

function ok(request: DetectRequest, detections: Detection[]): DetectResult {
  return {
    ok: true,
    rttMs: 1,
    data: {
      goal_id: request.goal_id,
      frame_id: request.frame_id,
      concept: request.concept,
      image: detections.length ? { width: 567, height: 1008 } : null,
      detections,
      timings_ms: { sam: 300, parse: 1, total: 310 },
    },
  };
}

/** `overrides` replaces deps, e.g. a sped-up clock. */
function harness(respond: Responder, overrides: Partial<ControllerDeps> = {}) {
  const spoken: string[] = [];
  /** Utterances stopped by speaker.stop() before they finished. */
  const cut: string[] = [];
  const haptics: string[] = [];
  const logs: string[] = [];
  const requests: DetectRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let goalCounter = 0;
  let speaking: { text: string; timer: ReturnType<typeof setTimeout>; onStopped: () => void } | null = null;
  const speaker: Speaker = {
    speak(text, _lang, callbacks) {
      spoken.push(text);
      const timer = setTimeout(() => {
        speaking = null;
        callbacks.onDone();
      }, 1);
      speaking = { text, timer, onStopped: callbacks.onStopped };
    },
    stop() {
      if (!speaking) return;
      const { text, timer, onStopped } = speaking;
      speaking = null;
      clearTimeout(timer);
      cut.push(text);
      onStopped();
    },
  };
  const deps: ControllerDeps = {
    capture: async () => ({ base64: '/9j/AAAA', captureMs: 1, processMs: 1 }),
    detect: async (request, signal) => {
      requests.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await respond(request, signal);
      } finally {
        inFlight--;
      }
    },
    speaker,
    haptic: (kind) => haptics.push(kind),
    now: () => performance.now(),
    newGoalId: () => `goal-${++goalCounter}`,
    log: (line) => logs.push(line),
    loop: { minCycleMs: 5, tickMs: 60_000 },
    retryDelay: () => 5,
    ...overrides,
  };
  const controller = createSearchController(deps);
  return {
    controller,
    spoken,
    cut,
    haptics,
    logs,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

async function until(condition: () => boolean, what: string, timeoutMs = 3000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NETWORK_DOWN: DetectResult = { ok: false, error: { kind: 'network', message: 'Network request failed' } };

describe('search controller', () => {
  it('captures and detects one frame at a time, confirms, speaks and buzzes, and stops', async () => {
    const h = harness(async (request) => {
      await pause(3);
      return ok(request, [det(0.2, 0.8)]);
    });
    try {
      h.controller.start('chair', 'en-US');
      await until(() => h.haptics.includes('found'), 'the found haptic');
      await until(() => h.spoken.length >= 2, 'the found announcement');
      assert.deepEqual(h.spoken.slice(0, 2), [
        'Looking for a chair. Move your phone slowly.',
        'I found a chair, on the left of the camera view.',
      ]);
      assert.equal(h.maxInFlight, 1, 'never more than one request in flight');
      assert.deepEqual(
        h.requests.map((r) => r.frame_id),
        h.requests.map((_, i) => i),
      );
      assert.ok(h.requests.every((r) => r.goal_id === 'goal-1' && r.concept === 'chair'));
      assert.equal(h.controller.getSnapshot().detections.length, 1);

      h.controller.stop();
      const sent = h.requests.length;
      await pause(30);
      assert.equal(h.requests.length, sent, 'no frames after stop');
      const snapshot = h.controller.getSnapshot();
      assert.equal(snapshot.search.status, 'CANCELLED');
      assert.deepEqual(snapshot.detections, []);
      await until(() => h.spoken.at(-1) === 'Stopped searching.', 'the stop reply');
      assert.ok(h.logs.some((l) => l.startsWith(METRICS_TAG) && l.includes('"reason":"stop"')));
    } finally {
      h.controller.shutdown();
    }
  });

  it('drops a late result for a goal that was replaced', async () => {
    let releaseFirst: (() => void) | null = null;
    const h = harness((request) => {
      if (request.goal_id === 'goal-1') {
        // Ignores the abort on purpose: the response arrives late anyway.
        return new Promise((resolve) => {
          releaseFirst = () => resolve(ok(request, [det(0.5, 0.95)]));
        });
      }
      return pause(3).then(() => ok(request, []));
    });
    try {
      h.controller.start('chair', 'en-US');
      await until(() => releaseFirst != null, 'the first request');
      h.controller.start('cup', 'en-US');
      releaseFirst!();
      await until(() => h.requests.some((r) => r.goal_id === 'goal-2'), 'a request for the new goal');
      await pause(20);
      const snapshot = h.controller.getSnapshot();
      assert.equal(snapshot.search.goal?.concept, 'cup');
      assert.equal(snapshot.search.status, 'SEARCHING');
      assert.deepEqual(snapshot.detections, [], 'the chair box never reached the overlay');
      assert.ok(!h.spoken.some((t) => t.includes('found')));
    } finally {
      h.controller.shutdown();
    }
  });

  it('says when the server cannot be reached, keeps trying, and says when it is back', async () => {
    let calls = 0;
    const h = harness(async (request) => {
      calls++;
      await pause(1);
      if (calls <= 3) return { ok: false, error: { kind: 'network', message: 'Network request failed' } };
      return ok(request, []);
    });
    try {
      h.controller.start('chair', 'en-US');
      await until(() => h.spoken.includes('Connected again.'), 'the reconnect message');
      assert.deepEqual(h.spoken, [
        'Looking for a chair. Move your phone slowly.',
        "I can't reach the HeyNavi server. I'll keep trying.",
        'Connected again.',
      ]);
      assert.equal(h.controller.getSnapshot().failing, null);
      assert.ok(h.logs.some((l) => l.includes('frame failed (network)')));
    } finally {
      h.controller.shutdown();
    }
  });

  it('speaks a re-find after it said it lost sight of the object', async () => {
    const h = harness(async (request) => {
      await pause(1);
      // Frames 0-1 confirm, 2-4 miss (lost), 5+ confirm again at the same position.
      const missing = request.frame_id >= 2 && request.frame_id <= 4;
      return ok(request, missing ? [] : [det(0.2, 0.8)]);
    });
    try {
      h.controller.start('chair', 'en-US');
      await until(() => h.haptics.filter((k) => k === 'found').length >= 2, 'the second found haptic');
      await until(() => h.spoken.length >= 4, 'the re-find announcement');
      assert.deepEqual(h.spoken.slice(0, 4), [
        'Looking for a chair. Move your phone slowly.',
        'I found a chair, on the left of the camera view.',
        'I lost sight of the chair. Still looking.',
        'I found a chair, on the left of the camera view.',
      ]);
    } finally {
      h.controller.shutdown();
    }
  });

  it('does not coach while no frame is analyzed, and coaches again after reconnecting', async () => {
    // 200x clock: 10 s of session time pass in 50 ms.
    const scale = 200;
    let down = true;
    const h = harness(
      async (request) => {
        await pause(1);
        return down ? NETWORK_DOWN : ok(request, []);
      },
      { now: () => performance.now() * scale, loop: { minCycleMs: 5, tickMs: 2 } },
    );
    const coaching = () => h.spoken.filter((t) => /^Still looking|^I haven't found/.test(t));
    try {
      const startedAt = performance.now();
      h.controller.start('chair', 'en-US');
      await until(() => (performance.now() - startedAt) * scale >= 75_000, '75 s of session time');
      assert.ok(h.spoken.includes("I can't reach the HeyNavi server. I'll keep trying."));
      assert.deepEqual(coaching(), [], 'no coaching during the outage');

      down = false;
      await until(() => h.spoken.includes('Connected again.'), 'the reconnect message');
      await until(() => coaching().length > 0, 'coaching after reconnecting');
      assert.equal(coaching()[0], 'Still looking for a chair. Try turning slowly.');
    } finally {
      h.controller.shutdown();
    }
  });

  it('waits for the server Retry-After before the next attempt', async () => {
    const sentAt: number[] = [];
    const h = harness(async (request) => {
      sentAt.push(performance.now());
      if (sentAt.length === 1) {
        return {
          ok: false,
          error: { kind: 'http', status: 429, code: 'rate_limited', message: 'slow down', retryAfterMs: 150 },
        };
      }
      return ok(request, []);
    });
    try {
      h.controller.start('chair', 'en-US');
      await until(() => sentAt.length >= 2, 'the second attempt');
      // The injected back-off is 5 ms, so only the Retry-After explains the wait.
      assert.ok(sentAt[1] - sentAt[0] >= 140, `waited ${Math.round(sentAt[1] - sentAt[0])} ms`);
    } finally {
      h.controller.shutdown();
    }
  });

  it('lets "Stopped searching." finish when the screen closes right after stop', async () => {
    const h = harness(async (request) => {
      await pause(2);
      return ok(request, []);
    });
    h.controller.start('chair', 'en-US');
    await until(() => h.requests.length >= 1, 'a frame');
    // VoiceOver escape: stop, then router.back() unmounts the screen.
    h.controller.stop();
    h.controller.shutdown();
    await pause(10);
    assert.equal(h.spoken.at(-1), 'Stopped searching.');
    assert.ok(!h.cut.includes('Stopped searching.'), 'the reply was not cut off');
    assert.equal(h.controller.getSnapshot().search.status, 'IDLE');
  });

  it('shutdown during a search stops speech about the goal', async () => {
    const h = harness(async (request) => {
      await pause(2);
      return ok(request, []);
    });
    h.controller.start('chair', 'en-US');
    // The start reply is still being spoken (the fake takes 1 ms).
    assert.equal(h.spoken.at(-1), 'Looking for a chair. Move your phone slowly.');
    h.controller.shutdown();
    assert.deepEqual(h.cut, ['Looking for a chair. Move your phone slowly.']);
    await pause(10);
    assert.equal(h.spoken.length, 1, 'nothing else is said');
  });

  it('pauses without frames or speech and resumes the same goal', async () => {
    const h = harness(async (request) => {
      await pause(2);
      return ok(request, []);
    });
    try {
      h.controller.start('door', 'en-US');
      await until(() => h.requests.length >= 2, 'two frames');
      assert.equal(h.controller.pause(), true);
      assert.equal(h.controller.getSnapshot().search.status, 'PAUSED');
      const sent = h.requests.length;
      await pause(30);
      assert.equal(h.requests.length, sent, 'no frames while paused');
      assert.equal(h.controller.resume(), true);
      await until(() => h.requests.length > sent, 'frames after resume');
      assert.ok(h.requests.every((r) => r.goal_id === 'goal-1'));
      await until(() => h.spoken.includes('Looking for a door again.'), 'the resume message');
      assert.equal(h.controller.resume(), false, 'not paused any more');
    } finally {
      h.controller.shutdown();
    }
    assert.equal(h.controller.getSnapshot().search.status, 'IDLE');
  });
});
