/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
// Drives the real scene loop with a fake camera, backend, speaker and clock (no Meta calls).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAnnouncer, type Speaker } from '../agent/announcer.ts';
import type { AskRequest, AskResult } from '../api/ask-response.ts';
import type { SceneRequest, SceneResult } from '../api/scene-response.ts';
import { det } from '../agent/test-helpers.ts';
import { METRICS_TAG } from '../session/metrics.ts';
import { createSceneController, type LastLook, type SceneDeps } from './scene-controller.ts';
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
      timings_ms: { spark: 3000, parse: 1, sam: 600, total: 3610 },
      usage: { input_tokens: 1600, output_tokens: 500, reasoning_tokens: 400, sam_images: 1, cost_usd: 0.004 },
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
      'A person is visible on the left of the camera view.',
    ]);
    assert.equal(h.maxInFlight, 1);
    assert.deepEqual(h.requests[0].context, { summary: null, items: [] });
    assert.equal(h.requests[0].session_id, 'scene-2');
    assert.deepEqual(h.requests[1].context.items, [{ label: 'door', kind: 'landmark', position: 'right', age_s: 0, spoken: true }]);
    assert.equal(h.requests[1].context.summary, 'A hallway with a door on the right');
    assert.equal(h.requests[1].detailed, false);
    assert.equal(h.requests[1].ground, 3);
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
      "A kitchen. There's a table in the center of the camera view, and a kettle on the right of the camera view.",
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

  it('does not speak about one slow look, only about two in a row', async () => {
    let calls = 0;
    const h = harness((request) => {
      calls++;
      if (calls === 2 || calls === 4 || calls === 5) {
        return { ok: false, error: { kind: 'http', status: 504, code: 'timeout', message: 'slow' } };
      }
      return ok(request, { summary: `View ${request.frame_id}`, change: 'major' });
    });
    h.controller.start();
    await until(() => calls >= 6, 'six looks');
    h.controller.shutdown();
    const slow = "The server is slow to answer. I'll keep trying.";
    assert.equal(h.spoken.filter((t) => t === slow).length, 1, 'only the second timeout in a row is spoken');
    assert.ok(h.spoken.indexOf(slow) > h.spoken.indexOf('View 0.'));
  });

  it('keeps the latest look for the decision panel: Spark items, SAM checks, the decision', async () => {
    const replies: Reply[] = [
      { summary: 'A hallway.', change: 'major' },
      {
        change: 'minor',
        items: [
          sceneItem('box', { kind: 'possible_obstacle', importance: 'high', band: 'lower', detections: [det(0.5, 0.82)] }),
          // SAM missed it, but Spark puts it in the walking area: still weighed (said hedged).
          sceneItem('person', { kind: 'person', importance: 'high', grounded: false }),
          sceneItem('poster', { kind: 'object', importance: 'low', grounded: null }),
        ],
      },
    ];
    let n = 0;
    const h = harness((request) => ok(request, replies[Math.min(n++, replies.length - 1)]));
    assert.equal(h.controller.getSnapshot().lastLook, null);
    const looks = new Map<number, LastLook>();
    h.controller.subscribe(() => {
      const last = h.controller.getSnapshot().lastLook;
      if (last && !looks.has(last.frame)) looks.set(last.frame, last);
    });
    h.controller.start();
    await until(() => looks.has(1), 'second look');
    const look = looks.get(1)!;
    h.controller.shutdown();
    assert.equal(look.change, 'minor');
    assert.deepEqual(
      look.items.map((i) => [i.label, i.sam, i.confidence, i.considered]),
      [
        ['box', 'found', 0.82, true],
        ['person', 'missed', null, true],
        ['poster', 'unchecked', null, false],
      ],
    );
    assert.equal(look.note, 'item');
    assert.match(look.said ?? '', /^Possible obstacle: a box/);
    assert.equal(look.sparkMs, 3000);
    assert.equal(look.samMs, 600);
    assert.equal(look.costUsd, 0.004);
    assert.equal(h.controller.getSnapshot().lastLook, null, 'shutdown clears it');
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

describe('questions', () => {
  function askResult(request: AskRequest, over: Partial<Extract<AskResult, { ok: true }>['data']> = {}): AskResult {
    return {
      ok: true,
      rttMs: 1,
      data: {
        answer: 'There is an entrance ahead on your right.',
        about: { label: 'entrance', ground: 'door', visible: true, position: 'right', band: 'middle', grounded: true, detections: [det(0.85, 0.9)] },
        search: false,
        timings_ms: { spark: 2500, sam: 500, total: 3000 },
        cost_usd: 0.006,
        ...over,
      },
    };
  }

  it('speaks the answer as a reply, boxes what it is about, and sends the hold', async () => {
    const asked: AskRequest[] = [];
    const h = harness((r) => ok(r), {
      ask: async (request) => {
        asked.push(request);
        return askResult(request);
      },
      hold: () => ({ frame: 'forward', downDeg: 10, reason: 'forward' }),
    });
    const outcome = await h.controller.ask('where is the entrance');
    assert.deepEqual(outcome, { searchFor: null });
    assert.deepEqual(h.spoken, ['There is an entrance ahead on your right.']);
    assert.equal(asked[0].hold, 'forward');
    assert.equal(asked[0].question, 'where is the entrance');
    assert.deepEqual(h.controller.getSnapshot().boxes.map((b) => b.label), ['entrance']);
    assert.equal(h.metrics('ask')[0].grounded, true);
  });

  it("says SAM's position when it disagrees with the model's", async () => {
    const h = harness((r) => ok(r), {
      ask: async (request) => askResult(request, { answer: 'There is an entrance ahead on your left.', about: { label: 'entrance', ground: 'door', visible: true, position: 'left', band: 'middle', grounded: true, detections: [det(0.85, 0.9)] } }),
      hold: () => ({ frame: 'forward', downDeg: 10, reason: 'forward' }),
    });
    await h.controller.ask('where is the entrance');
    assert.deepEqual(h.spoken, ['An entrance is visible ahead on your right.']);
  });

  it('hands off a search when the thing is not in view, and says when it cannot answer', async () => {
    const h = harness((r) => ok(r), {
      ask: async (request) =>
        request.question === 'where is the entrance'
          ? askResult(request, { answer: "I don't see an entrance right now.", search: true, about: { label: 'entrance', ground: 'door', visible: false, position: 'center', band: 'middle', grounded: null, detections: [] } })
          : askResult(request, { answer: null, about: null }),
    });
    assert.deepEqual(await h.controller.ask('where is the entrance'), { searchFor: 'door' });
    await h.controller.ask('is it safe to cross');
    await until(() => h.spoken.length >= 2, 'both answers');
    assert.deepEqual(h.spoken, ["I don't see an entrance right now.", "I can't answer that from the camera view."]);
  });
});
