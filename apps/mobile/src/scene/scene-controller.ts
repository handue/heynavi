/**
 * Continuous scene understanding without React (ARCHITECTURE 4): capture -> /v1/scene ->
 * scene memory -> attention policy -> announcer, one Spark call in flight, every 4–8 s.
 * Camera, network, the shared announcer and the clock are injected, so the loop runs under
 * `node --test` with fakes. The session hook wires in the real ones.
 */
import type { Announcement, Announcer } from '../agent/announcer.ts';
import type { Detection } from '../agent/types.ts';
import { phrases, type ErrorKind } from '../agent/phrases.ts';
import type { ApiError } from '../api/detect-response.ts';
import type { AskRequest, AskResult } from '../api/ask-response.ts';
import type { SceneRequest, SceneResult } from '../api/scene-response.ts';
import { withAbortAndTimeout } from '../lib/async.ts';
import { sleep } from '../lib/sleep.ts';
import { percentile, round } from '../lib/stats.ts';
import { METRICS_TAG, spread } from '../session/metrics.ts';
import {
  NO_FAILURES,
  errorKindFor,
  recordFailure,
  recordSuccess,
  retryDelayMs,
  withRetryAfter,
  type FailureState,
} from '../session/retry-policy.ts';
import type { HoldReading } from '../perception/orientation.ts';
import type { FrameCapture } from '../session/search-controller.ts';
import { INITIAL_POLICY, decide, isHazard, mention, walkingRelevant, type DecisionNote, type PolicyState } from './attention-policy.ts';
import { EMPTY_MEMORY, bandOf, contextFor, expire, markSpoken, mergeReply, pickBox, type MemoryItem, type SceneMemory } from './scene-memory.ts';
import { scenePhrases } from './scene-phrases.ts';
import { VERBOSITY_STEPS, type Verbosity } from './types.ts';
import { unspeakableReason } from './wording.ts';

export const SCENE_LOOP = {
  /** The next frame is captured this long after the previous one (one Spark call in flight). */
  intervalMs: 4000,
  /** After `slowAfterQuiet` replies in a row with no change, the interval stretches to this. */
  slowIntervalMs: 8000,
  slowAfterQuiet: 2,
  /** How many of Spark's items SAM checks on each frame (each check is one SAM call). */
  ground: 3,
  /** Every wait yields at least this long, so the loop can never spin without a pause. */
  minWaitMs: 50,
  /** A capture (incl. resize) that takes longer than this fails the cycle. */
  captureTimeoutMs: 5000,
  /** A summary line is logged every this many replies, and when exploring pauses. */
  metricsEvery: 10,
  maxMetrics: 900,
} as const;

export type SceneLoopOptions = { [K in keyof typeof SCENE_LOOP]: number };

/** Why exploring is paused; it runs only while none applies. */
export type ScenePause = 'user' | 'search' | 'background' | 'budget';

export type SceneDeps = {
  capture(signal: AbortSignal): Promise<FrameCapture>;
  scene(request: SceneRequest, signal: AbortSignal): Promise<SceneResult>;
  /** POST /v1/ask (questions); without it, questions are not answered. */
  ask?(request: AskRequest, signal: AbortSignal): Promise<AskResult>;
  /** Shared with the search, so only one line plays at a time. */
  announcer: Announcer;
  /** How the phone is held right now (sampled when a frame is taken); null without a sensor. */
  hold?(): HoldReading | null;
  /** Monotonic ms (performance.now in the app). */
  now(): number;
  newSessionId(): string;
  /** Metrics: timings, counts and decisions only. */
  log(line: string): void;
  /** Scene content (summaries, labels, spoken lines), for development builds only. */
  devLog?(line: string): void;
  loop?: Partial<SceneLoopOptions>;
  retryDelay?: (failures: number) => number;
};

/** One box on the preview: a SAM-confirmed item from the latest reply. */
export type SceneBox = { key: string; label: string; detection: Detection; obstacle: boolean };

export type SceneSnapshot = {
  started: boolean;
  running: boolean;
  pausedBy: readonly ScenePause[];
  verbosity: Verbosity;
  /** Latest summary that passed the backend filter (shown on screen, not necessarily spoken). */
  summary: string | null;
  items: readonly MemoryItem[];
  /** SAM boxes of the latest reply, for the preview overlay; empty while paused. */
  boxes: readonly SceneBox[];
  /** How the phone was held for the latest frame (sets the wording of directions). */
  hold: HoldReading | null;
  calls: number;
  lastRttMs: number | null;
  p50RttMs: number | null;
  lastSparkMs: number | null;
  costUsd: number;
  failing: ErrorKind | null;
  describing: boolean;
};

export type SceneController = {
  /** Starts exploring (the session opened): says so, then looks every few seconds. */
  start(): void;
  /** Returns true when this stopped a running loop. */
  pause(reason: ScenePause): boolean;
  /** Clears one pause reason; returns true when the loop started again. */
  resume(reason: ScenePause): boolean;
  isPausedBy(reason: ScenePause): boolean;
  /** "What's around me": a priority-0 answer about the current view, paused or not. */
  describeNow(): void;
  /**
   * A question about the current view ("where is the entrance"): one look, a priority-0 answer,
   * and a box around what it is about. `searchFor` is set when the thing is not in view and the
   * session should start a search for it. A newer question cancels an older one.
   */
  ask(question: string): Promise<{ searchFor: string | null }>;
  /** Steps verbosity; returns false at either end. */
  stepVerbosity(delta: 1 | -1): boolean;
  readonly verbosity: Verbosity;
  /** Forwarded from the announcer: logs frame-to-speech latency of scene lines. */
  speechStarted(announcement: Announcement, at: number): void;
  /** Unmount: stops everything and logs a summary. start() works again afterwards. */
  shutdown(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SceneSnapshot;
};

type ReplyMetrics = {
  captureMs: number;
  processMs: number;
  rttMs: number;
  sparkMs: number | null;
  totalMs: number;
  costUsd: number;
};

type CycleOutcome = { ok: true } | { ok: false; retryAfterMs: number | null };

/**
 * Failures the scene loop says at once. Not "slow": one Spark call over its timeout is followed
 * by the next look a moment later, so it is only said when it happens twice in a row (round 4).
 */
const SCENE_SAY_AT_ONCE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['unauthorized', 'notConfigured', 'cantAnalyze', 'budget']);

export function createSceneController(deps: SceneDeps): SceneController {
  const options: SceneLoopOptions = { ...SCENE_LOOP, ...deps.loop };
  const retryDelay = deps.retryDelay ?? retryDelayMs;
  const { announcer } = deps;
  const listeners = new Set<() => void>();

  let started = false;
  const pausedBy = new Set<ScenePause>();
  let verbosity: Verbosity = 'normal';
  let sessionId = deps.newSessionId();
  let memory: SceneMemory = EMPTY_MEMORY;
  let policy: PolicyState = INITIAL_POLICY;
  let lastSummary: string | null = null;
  let boxes: SceneBox[] = [];
  let lastHold: HoldReading | null = null;
  let loop: AbortController | null = null;
  let oneShot: AbortController | null = null;
  let asking: AbortController | null = null;
  /** Each answer gets its own announcer key: a second answer must not count as a repeat of the first. */
  let askCount = 0;
  let wake: (() => void) | null = null;
  let inFlight = false;
  /** The next reply answers "what's around me" (it may be the one already in flight). */
  let describePending = false;
  let quietStreak = 0;
  let nextFrameId = 0;
  let failures: FailureState = NO_FAILURES;
  let failureTotal = 0;
  let failing: ErrorKind | null = null;
  let metrics: ReplyMetrics[] = [];
  let calls = 0;
  let costUsd = 0;
  let lines = 0;
  let notes: Partial<Record<DecisionNote, number>> = {};
  let frameToSpeech: number[] = [];
  let activeMs = 0;
  let runningSince: number | null = null;
  /** Lines waiting to start playing: key -> when their frame capture began. */
  const pendingLines = new Map<string, { frameAt: number; replyAt: number }>();
  let snapshot = makeSnapshot();

  function makeSnapshot(): SceneSnapshot {
    const last = metrics[metrics.length - 1];
    const p50 = percentile(
      metrics.map((m) => m.rttMs),
      50,
    );
    return {
      started,
      running: loop != null,
      pausedBy: [...pausedBy],
      verbosity,
      summary: lastSummary,
      items: memory.items,
      boxes,
      hold: lastHold,
      calls,
      lastRttMs: last?.rttMs ?? null,
      p50RttMs: p50 == null ? null : round(p50),
      lastSparkMs: last?.sparkMs ?? null,
      costUsd: round(costUsd, 4),
      failing,
      describing: describePending || oneShot != null,
    };
  }

  function publish() {
    snapshot = makeSnapshot();
    for (const listener of listeners) listener();
  }

  function metricsLine(fields: Record<string, unknown>): string {
    return `${METRICS_TAG} ${JSON.stringify(fields)}`;
  }

  function logSummary(reason: 'periodic' | 'pause' | 'stop') {
    if (calls + failureTotal === 0) return;
    const now = deps.now();
    const active = activeMs + (runningSince == null ? 0 : now - runningSince);
    const minutes = active / 60_000;
    deps.log(
      metricsLine({
        reason: 'scene-summary',
        trigger: reason,
        calls,
        failures: failureTotal,
        rttMs: spread(metrics.map((m) => m.rttMs)),
        sparkMs: spread(metrics.flatMap((m) => (m.sparkMs == null ? [] : [m.sparkMs]))),
        totalMs: spread(metrics.map((m) => m.totalMs)),
        frameToSpeechMs: spread(frameToSpeech),
        lines,
        notes,
        activeMin: round(minutes, 2),
        linesPerMin: minutes > 0 ? round(lines / minutes, 2) : null,
        costUsd: round(costUsd, 4),
        costPerMin: minutes > 0 ? round(costUsd / minutes, 4) : null,
      }),
    );
  }

  function running(): boolean {
    return started && pausedBy.size === 0;
  }

  function startLoop() {
    if (loop) return;
    const controller = new AbortController();
    loop = controller;
    runningSince = deps.now();
    void runLoop(controller.signal);
  }

  function stopLoop() {
    if (!loop) return;
    loop.abort();
    loop = null;
    wake?.();
    if (runningSince != null) activeMs += deps.now() - runningSince;
    runningSince = null;
    inFlight = false;
  }

  async function runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      const startedAt = deps.now();
      const outcome = await runCycle(signal, describePending);
      if (signal.aborted) return;
      const interval = quietStreak >= options.slowAfterQuiet ? options.slowIntervalMs : options.intervalMs;
      const wait = Math.max(
        options.minWaitMs,
        outcome.ok
          ? describePending
            ? 0
            : interval - (deps.now() - startedAt)
          : withRetryAfter(retryDelay(failures.count), outcome.retryAfterMs),
      );
      const nap = new AbortController();
      const onAbort = () => nap.abort();
      signal.addEventListener('abort', onAbort);
      wake = () => nap.abort();
      await sleep(wait, nap.signal);
      signal.removeEventListener('abort', onAbort);
      wake = null;
    }
  }

  /** One capture + one Spark call. Never throws. */
  async function runCycle(signal: AbortSignal, detailed: boolean): Promise<CycleOutcome> {
    const frameId = nextFrameId++;
    const frameAt = deps.now();
    const hold = deps.hold?.() ?? null;
    lastHold = hold;
    inFlight = true;
    try {
      let frame: FrameCapture;
      try {
        frame = await withAbortAndTimeout(
          deps.capture(signal),
          signal,
          options.captureTimeoutMs,
          `Capture timed out after ${options.captureTimeoutMs} ms`,
        );
      } catch (e) {
        if (!signal.aborted) fail('camera', errorMessage(e), null);
        return { ok: false, retryAfterMs: null };
      }
      if (signal.aborted) return { ok: false, retryAfterMs: null };

      const sentAt = deps.now();
      let result: SceneResult;
      try {
        result = await deps.scene(
          {
            image_b64: frame.base64,
            session_id: sessionId,
            frame_id: frameId,
            context: contextFor(memory, sentAt),
            detailed,
            ground: options.ground,
          },
          signal,
        );
      } catch (e) {
        result = { ok: false, error: { kind: 'network', message: errorMessage(e) } };
      }
      if (signal.aborted) return { ok: false, retryAfterMs: null };
      if (!result.ok) {
        const { error } = result;
        fail(errorKindFor(error), describeError(error), error);
        return { ok: false, retryAfterMs: error.kind === 'http' ? (error.retryAfterMs ?? null) : null };
      }

      succeed();
      const receivedAt = deps.now();
      const { data } = result;
      const describe = describePending;
      describePending = false;
      const merged = mergeReply(memory, data, receivedAt);
      const decision = decide({
        reply: data,
        merged,
        verbosity,
        state: policy,
        now: receivedAt,
        describe,
        frame: hold?.frame ?? 'camera',
      });
      memory = markSpoken(merged.memory, decision.spokenKeys, receivedAt);
      policy = decision.state;
      if (data.summary) lastSummary = data.summary;
      const byKey = new Map(memory.items.map((i) => [i.key, i]));
      // Boxes only for walking-relevant things SAM found: no outlines around pictures or screens.
      boxes = merged.reported.flatMap((item) => {
        const remembered = byKey.get(item.key);
        if (!remembered?.box || item.grounded !== true || !walkingRelevant(remembered)) return [];
        return [{ key: item.key, label: item.label, detection: remembered.box, obstacle: isHazard(remembered) }];
      });
      quietStreak = data.change === 'none' ? quietStreak + 1 : 0;
      notes = { ...notes, [decision.note]: (notes[decision.note] ?? 0) + 1 };
      if (decision.announcement) {
        lines++;
        // A second "what's around me" must not count as a repeat of the first.
        const announcement =
          decision.announcement.channel === 'reply'
            ? { ...decision.announcement, key: `${decision.announcement.key}:${frameId}` }
            : decision.announcement;
        pendingLines.set(announcement.key, { frameAt, replyAt: receivedAt });
        announcer.announce(announcement);
      }

      calls++;
      const cost = data.usage?.cost_usd ?? 0;
      costUsd += cost;
      metrics.push({
        captureMs: frame.captureMs,
        processMs: frame.processMs,
        rttMs: round(receivedAt - sentAt),
        sparkMs: data.timings_ms?.spark ?? null,
        totalMs: round(receivedAt - frameAt),
        costUsd: cost,
      });
      if (metrics.length > options.maxMetrics) metrics = metrics.slice(-options.maxMetrics);
      deps.log(
        metricsLine({
          reason: 'scene',
          frame: frameId,
          captureMs: frame.captureMs,
          processMs: frame.processMs,
          rttMs: round(receivedAt - sentAt),
          sparkMs: data.timings_ms?.spark ?? null,
          samMs: data.timings_ms?.sam ?? null,
          totalMs: round(receivedAt - frameAt),
          grounded: `${data.items.filter((i) => i.grounded === true).length}/${data.items.filter((i) => i.grounded != null).length}`,
          // Reported but never said on HeyNavi's own initiative (not walking-relevant at this verbosity).
          suppressed: merged.reported.filter((i) => mention(i, verbosity) == null).length,
          hold: hold ? `${hold.frame}:${hold.reason}:${hold.downDeg}` : null,
          inTok: data.usage?.input_tokens ?? null,
          outTok: data.usage?.output_tokens ?? null,
          reasonTok: data.usage?.reasoning_tokens ?? null,
          costUsd: round(cost, 5),
          change: data.change,
          items: data.items.length,
          filtered: data.filtered,
          detailed,
          note: decision.note,
          key: decision.announcement?.key ?? null,
        }),
      );
      deps.devLog?.(
        `[heynavi-scene] #${frameId} ${data.change} summary=${JSON.stringify(data.summary)} items=` +
          data.items
            .map(
              (i) =>
                `${i.label}x${i.count}(${i.kind},${i.position},${i.band},${i.importance},${i.status},` +
                `sam=${i.grounded == null ? '-' : i.grounded ? (i.detections[0]?.confidence?.toFixed(2) ?? 'y') : 'no'})`,
            )
            .join(' ') +
          ` -> ${decision.note}${decision.announcement ? ` ${JSON.stringify(decision.announcement.text)}` : ''}`,
      );
      if (calls % options.metricsEvery === 0) logSummary('periodic');
      publish();
      return { ok: true };
    } finally {
      inFlight = false;
    }
  }

  function fail(kind: ErrorKind, message: string, error: ApiError | null) {
    failureTotal++;
    const result = recordFailure(failures, kind, deps.now(), SCENE_SAY_AT_ONCE);
    failures = result.state;
    failing = kind;
    deps.log(`[heynavi] scene frame failed (${kind}): ${message}`);
    if (result.announce || describePending) {
      describePending = false;
      announcer.announce({
        key: `error:scene:${kind}`,
        priority: 2,
        text: phrases('en-US').error(kind),
        lang: 'en-US',
        ttlMs: 6000,
        dedupeMs: 0,
        goalId: null,
        channel: 'status',
      });
    }
    // Retrying would only fail again until the backend's day rolls over.
    if (error?.kind === 'http' && error.code === 'budget_exhausted') {
      pausedBy.add('budget');
      stopLoop();
    }
    publish();
  }

  function succeed() {
    const result = recordSuccess(failures);
    failures = result.state;
    failing = null;
    if (result.reconnected) {
      announcer.announce({
        key: 'reconnected:scene',
        priority: 2,
        text: phrases('en-US').reconnected(),
        lang: 'en-US',
        ttlMs: 4000,
        dedupeMs: 0,
        goalId: null,
        channel: 'status',
      });
    }
  }

  /** "What's around me" while the loop is paused or off: one detailed look, outside the loop. */
  async function describeOnce() {
    const controller = new AbortController();
    oneShot = controller;
    describePending = true;
    publish();
    await runCycle(controller.signal, true);
    if (oneShot === controller) oneShot = null;
    describePending = false;
    publish();
  }

  function reply(key: string, text: string) {
    announcer.announce({ key, priority: 0, text, lang: 'en-US', ttlMs: 10_000, dedupeMs: 0, goalId: null, channel: 'reply' });
  }

  async function answer(question: string): Promise<{ searchFor: string | null }> {
    asking?.abort();
    const controller = new AbortController();
    asking = controller;
    const key = `reply:ask:${++askCount}`;
    const { signal } = controller;
    const frameAt = deps.now();
    const hold = deps.hold?.() ?? null;
    const frame = hold?.frame ?? 'camera';
    try {
      let image: FrameCapture;
      try {
        image = await withAbortAndTimeout(deps.capture(signal), signal, options.captureTimeoutMs, 'Capture timed out');
      } catch (e) {
        if (!signal.aborted) reply(key, phrases('en-US').error('camera'));
        return { searchFor: null };
      }
      const sentAt = deps.now();
      const result = await deps.ask!(
        { image_b64: image.base64, session_id: sessionId, question, context: contextFor(memory, sentAt), hold: frame },
        signal,
      );
      if (signal.aborted) return { searchFor: null };
      if (!result.ok) {
        deps.log(`[heynavi] question failed: ${describeError(result.error)}`);
        reply(key, phrases('en-US').error(errorKindFor(result.error)));
        return { searchFor: null };
      }
      const receivedAt = deps.now();
      const { data } = result;
      const about = data.about;
      const box = about?.grounded ? pickBox(about.detections, about.position) : null;
      // SAM's box is more precise than the model's thirds: when they disagree, say SAM's.
      let text = data.answer ?? scenePhrases.cannotAnswer();
      if (about && box && (box.position !== about.position || data.answer == null)) {
        text = scenePhrases.visible({ label: about.label, count: 1, position: box.position, band: bandOf(box) }, frame);
      }
      if (unspeakableReason(text) != null) text = scenePhrases.cannotAnswer();
      reply(key, text);
      if (about && box) boxes = [{ key: `ask:${about.label}`, label: about.label, detection: box, obstacle: false }];
      costUsd += data.cost_usd ?? 0;
      deps.log(
        metricsLine({
          reason: 'ask',
          rttMs: round(receivedAt - sentAt),
          sparkMs: data.timings_ms?.spark ?? null,
          samMs: data.timings_ms?.sam ?? null,
          totalMs: round(receivedAt - frameAt),
          answered: data.answer != null,
          grounded: about?.grounded ?? null,
          search: data.search,
          hold: frame,
          costUsd: data.cost_usd,
        }),
      );
      deps.devLog?.(`[heynavi-scene] ask ${JSON.stringify(question)} -> ${JSON.stringify(text)}${data.search ? ` (search ${about?.ground})` : ''}`);
      publish();
      return { searchFor: data.search && about?.ground ? about.ground : null };
    } finally {
      if (asking === controller) asking = null;
    }
  }

  function resetForNewRun() {
    memory = expire(memory, deps.now());
    // A fresh first look after a pause: the user may have moved meanwhile.
    policy = { ...INITIAL_POLICY, spokenAt: policy.spokenAt };
    failures = NO_FAILURES;
    failing = null;
    quietStreak = 0;
  }

  return {
    start() {
      if (started) return;
      started = true;
      sessionId = deps.newSessionId();
      resetForNewRun();
      announcer.announce({
        key: 'scene:start',
        priority: 0,
        text: scenePhrases.exploreStart(),
        lang: 'en-US',
        ttlMs: 5000,
        dedupeMs: 0,
        goalId: null,
        channel: 'reply',
      });
      if (running()) startLoop();
      publish();
    },

    pause(reason) {
      // Idempotent and silent when nothing changes: the session calls it on every search update.
      if (pausedBy.has(reason)) return false;
      const wasRunning = loop != null;
      pausedBy.add(reason);
      if (wasRunning) {
        stopLoop();
        describePending = false;
        boxes = [];
        announcer.clearChannel('camera');
        logSummary('pause');
      }
      publish();
      return wasRunning;
    },

    resume(reason) {
      if (!pausedBy.delete(reason)) return false;
      const resumed = running() && loop == null;
      if (resumed) {
        resetForNewRun();
        startLoop();
      }
      publish();
      return resumed;
    },

    isPausedBy(reason) {
      return pausedBy.has(reason);
    },

    ask(question) {
      if (!deps.ask) return Promise.resolve({ searchFor: null });
      return answer(question);
    },

    describeNow() {
      if (loop) {
        describePending = true;
        // An idle loop looks right away; one in flight answers with the reply it is waiting for.
        if (!inFlight) wake?.();
        publish();
        return;
      }
      if (!oneShot) void describeOnce();
    },

    stepVerbosity(delta) {
      const index = VERBOSITY_STEPS.indexOf(verbosity) + delta;
      if (index < 0 || index >= VERBOSITY_STEPS.length) return false;
      verbosity = VERBOSITY_STEPS[index];
      publish();
      return true;
    },

    get verbosity() {
      return verbosity;
    },

    speechStarted(announcement, at) {
      const pending = pendingLines.get(announcement.key);
      if (!pending) return;
      pendingLines.delete(announcement.key);
      const ms = round(at - pending.frameAt);
      frameToSpeech.push(ms);
      if (frameToSpeech.length > options.maxMetrics) frameToSpeech = frameToSpeech.slice(-options.maxMetrics);
      deps.log(
        metricsLine({ reason: 'scene-spoken', key: announcement.key, frameToSpeechMs: ms, replyToSpeechMs: round(at - pending.replyAt) }),
      );
    },

    shutdown() {
      stopLoop();
      oneShot?.abort();
      oneShot = null;
      asking?.abort();
      asking = null;
      logSummary('stop');
      announcer.clearChannel('camera');
      started = false;
      pausedBy.clear();
      memory = EMPTY_MEMORY;
      policy = INITIAL_POLICY;
      lastSummary = null;
      boxes = [];
      describePending = false;
      pendingLines.clear();
      metrics = [];
      frameToSpeech = [];
      calls = 0;
      costUsd = 0;
      lines = 0;
      notes = {};
      failureTotal = 0;
      activeMs = 0;
      failures = NO_FAILURES;
      failing = null;
      publish();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return snapshot;
    },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeError(error: ApiError): string {
  return error.kind === 'http' ? `HTTP ${error.status} ${error.code}: ${error.message}` : error.message;
}
