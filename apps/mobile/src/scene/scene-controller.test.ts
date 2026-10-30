/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// Drives the real scene loop with a fake camera, backend, speaker and clock (no Meta calls).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAnnouncer, type Speaker } from '../agent/announcer.ts';
import type { SceneRequest, SceneResult } from '../api/scene-response.ts';
import { METRICS_TAG } from '../session/metrics.ts';
import { createSceneController, type SceneDeps } from './scene-controller.ts';
import { sceneItem } from './scene-test-helpers.ts';
import type { SceneChange, SceneItem } from './types.ts';

type Reply = { summary?: string | null; change?: SceneChange; items?: SceneItem[] };
type Responder = (request: SceneRequest, signal: AbortSignal) => Promise<SceneResult> | SceneResult;

function ok(request: SceneRequest, reply: Reply = {}): SceneResult {
  return {
    ok: true,
    rttMs: 1,
    data: {
      session_id: request.session_id,
      frame_id: request.frame_id,
      summary: reply.summary ?? null,
      change: reply.change ?? 'minor',
      items: reply.items ?? [],
      filtered: [],
      timings_ms: { spark: 3000, parse: 1, total: 3010 },
      usage: { input_tokens: 1600, output_tokens: 500, reasoning_tokens: 400, cost_usd: 0.004 },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

async function until(check: () => boolean, label: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

/** Every scene call moves the fake clock 7 s forward, past the policy's minimum gap. */
function harness(respond: Responder, overrides: Partial<SceneDeps> = {}) {
  let clock = 0;
  const spoken: string[] = [];
  const logs: string[] = [];
  const requests: SceneRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const speaker: Speaker = {
    speak(text, _lang, callbacks) {
      spoken.push(text);
      callbacks.onStart?.();
      setTimeout(callbacks.onDone, 1);
    },
    stop() {},
  };
  let controllerRef: ReturnType<typeof createSceneController> | null = null;
  const announcer = createAnnouncer(speaker, {
    now: () => clock,
    onSpeechStart: (a, at) => controllerRef?.speechStarted(a, at),
  });
  let sessions = 0;
  const controller = createSceneController({
    capture: async () => ({ base64: '/9j/AAAA', captureMs: 400, processMs: 50 }),
    scene: async (request, signal) => {
      requests.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        clock += 7000;
        return await respond(request, signal);
      } finally {
        inFlight--;
      }
    },
    announcer,
    now: () => clock,
    newSessionId: () => `scene-${++sessions}`,
    log: (line) => logs.push(line),
    loop: { intervalMs: 5, slowIntervalMs: 5, minWaitMs: 1 },
    retryDelay: () => 5,
    ...overrides,
  });
  controllerRef = controller;
  return {
    controller,
    announcer,
    spoken,
    logs,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    metrics(reason: string) {
      return logs
        .filter((l) => l.startsWith(METRICS_TAG))
        .map((l) => JSON.parse(l.slice(METRICS_TAG.length + 1)) as Record<string, unknown>)
        .filter((m) => m.reason === reason);
    },
  };
}

describe('scene loop', () => {
  it('announces exploring, then speaks a first look and new items, with memory as context', async () => {
    const replies: Reply[] = [
      { summary: 'A hallway with a door on the right', change: 'major', items: [sceneItem('door', { kind: 'landmark', position: 'right' })] },
      { items: [sceneItem('door', { kind: 'landmark', position: 'right', status: 'still' }), sceneItem('person', { kind: 'person', position: 'left' })] },
    ];
    const h = harness((request) => ok(request, replies[Math.min(request.frame_id, replies.length - 1)]));
    h.controller.start();
    await until(() => h.spoken.length >= 3, 'three lines');
    h.controller.shutdown();
    assert.deepEqual(h.spoken.slice(0, 3), [
      "I'm looking around. I'll tell you what I notice.",
      'A hallway with a door on the right.',
      'I see a person on the left of the camera view.',
    ]);
    assert.equal(h.maxInFlight, 1);
    assert.deepEqual(h.requests[0].context, { summary: null, items: [] });
    assert.equal(h.requests[0].session_id, 'scene-2');
    assert.deepEqual(h.requests[1].context.items, [{ label: 'door', kind: 'landmark', position: 'right', age_s: 0, spoken: true }]);
    assert.equal(h.requests[1].context.summary, 'A hallway with a door on the right');
    assert.equal(h.requests[1].detailed, false);
  });

  it('logs per-reply metrics, frame-to-speech latency and a summary', async () => {
    const h = harness((request) => ok(request, { summary: 'A room', change: 'major' }));
    h.controller.start();
    await until(() => h.metrics('scene').length >= 2, 'two replies');
    h.controller.shutdown();
    const [first] = h.metrics('scene');
    assert.equal(first.note, 'first-look');
    assert.equal(first.key, 'scene:first-look');
    assert.equal(first.inTok, 1600);
    assert.equal(first.costUsd, 0.004);
    const [spoken] = h.metrics('scene-spoken');
    assert.equal(spoken.key, 'scene:first-look');
    assert.equal(spoken.frameToSpeechMs, 7000);
    const [summary] = h.metrics('scene-summary');
    assert.ok((summary.calls as number) >= 2);
    assert.equal(summary.trigger, 'stop');
  });

  it('pauses for a search, cancels camera lines, and looks afresh after', async () => {
    let block: (() => void) | null = null;
    const h = harness(async (request) => {
      if (request.frame_id === 1) await new Promise<void>((resolve) => (block = resolve));
      return ok(request, { summary: `View ${request.frame_id}`, change: 'major' });
    });
    h.controller.start();
    await until(() => block != null, 'second call in flight');
    assert.equal(h.controller.pause('search'), true);
    (block as unknown as () => void)();
    await tick();
    const callsWhilePaused = h.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.requests.length, callsWhilePaused, 'no calls while paused');
    assert.ok(!h.spoken.includes('View 1.'), 'the reply that came back after the pause is dropped');
    assert.equal(h.controller.getSnapshot().running, false);

    assert.equal(h.controller.resume('search'), true);
    await until(() => h.spoken.some((s) => /^View [2-9]\.$/.test(s)), 'a fresh first look');
    h.controller.shutdown();
  });

  it('stays paused until every reason is cleared', () => {
    const h = harness((request) => ok(request));
    h.controller.start();
    h.controller.pause('user');
    h.controller.pause('search');
    assert.equal(h.controller.resume('search'), false);
    assert.equal(h.controller.getSnapshot().running, false);
    assert.equal(h.controller.resume('user'), true);
    h.controller.shutdown();
  });

  it('answers "what\'s around me" while paused, with one detailed look', async () => {
    const h = harness((request) =>
      ok(request, { summary: 'A kitchen', change: 'major', items: [sceneItem('table'), sceneItem('kettle', { position: 'right' })] }),
    );
    h.controller.start();
    h.controller.pause('user');
    h.controller.describeNow();
    await until(() => h.spoken.length >= 2, 'the answer');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].detailed, true);
    assert.equal(
      h.spoken[1],
      'A kitchen. I see a table in the center of the camera view, and a kettle on the right of the camera view.',
    );
    assert.equal(h.controller.getSnapshot().running, false);
    h.controller.shutdown();
  });

  it('stops for the day when the backend reports the spending limit', async () => {
    const h = harness(() => ({
      ok: false,
      error: { kind: 'http', status: 503, code: 'budget_exhausted', message: 'limit' },
    }));
    h.controller.start();
    await until(() => h.controller.isPausedBy('budget'), 'the budget pause');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.requests.length, 1);
    assert.ok(h.spoken.includes("Today's limit for AI model calls is reached, so I can't look right now."));
    h.controller.shutdown();
  });

  it('steps verbosity within its range', () => {
    const h = harness((request) => ok(request));
    assert.equal(h.controller.verbosity, 'normal');
    assert.equal(h.controller.stepVerbosity(1), true);
    assert.equal(h.controller.stepVerbosity(1), false);
    assert.equal(h.controller.verbosity, 'detailed');
    assert.equal(h.controller.stepVerbosity(-1), true);
    assert.equal(h.controller.stepVerbosity(-1), true);
    assert.equal(h.controller.stepVerbosity(-1), false);
    assert.equal(h.controller.verbosity, 'quiet');
  });
});
