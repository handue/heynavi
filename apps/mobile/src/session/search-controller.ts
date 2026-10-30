/**
 * The search session without React: capture loop, reducer, effects, metrics and error speech.
 * Camera, network, speech, haptics and the clock are injected, so the loop itself runs under
 * `node --test` with fakes. `use-camera-session.ts` wires in the real ones.
 */
import { createAnnouncer, type Announcer, type Speaker } from '../agent/announcer.ts';
import { conceptLabel, phrases, type ErrorKind } from '../agent/phrases.ts';
import { SEARCH, initialSearchState, isActive, reduce, type SearchEvent } from '../agent/search-machine.ts';
import type { Detection, Effect, Goal, HapticKind, Lang, SearchState } from '../agent/types.ts';
import type { ApiError, DetectRequest, DetectResult } from '../api/detect-response.ts';
import { withAbortAndTimeout } from '../lib/async.ts';
import { sleep } from '../lib/sleep.ts';
import { percentile, round } from '../lib/stats.ts';
import { metricsLogLine, statusLogLine, type FrameMetrics } from './metrics.ts';
import {
  NO_FAILURES,
  errorKindFor,
  recordFailure,
  recordSuccess,
  retryDelayMs,
  withRetryAfter,
  type FailureState,
} from './retry-policy.ts';

export const LOOP = {
  /** The next cycle starts max(0, minCycleMs - elapsed) after the previous one finished. */
  minCycleMs: 800,
  /** A capture (incl. resize) that takes longer than this fails the cycle. */
  captureTimeoutMs: 5000,
  /** Clock for coaching prompts. */
  tickMs: 500,
  /** A metrics summary is logged every this many frames, and on stop. */
  metricsEvery: 10,
  /** Frames kept for the summary (about half an hour at 1 fps). */
  maxMetrics: 1800,
} as const;

export type LoopOptions = { [K in keyof typeof LOOP]: number };

/** How a cycle ended. A failed one may carry the server's Retry-After. */
type CycleOutcome = { ok: true } | { ok: false; retryAfterMs: number | null };

/** What the loop needs from a capture; perception/capture.ts returns more. */
export type FrameCapture = { base64: string; captureMs: number; processMs: number };

export type ControllerDeps = {
  capture(signal: AbortSignal): Promise<FrameCapture>;
  detect(request: DetectRequest, signal: AbortSignal): Promise<DetectResult>;
  speaker: Speaker;
  /** The session's shared announcer (so scene lines and search lines never overlap); by default one on `speaker`. */
  announcer?: Announcer;
  haptic(kind: HapticKind): void;
  /** Monotonic ms (performance.now in the app). */
  now(): number;
  newGoalId(): string;
  log(line: string): void;
  loop?: Partial<LoopOptions>;
  /** Back-off after `failures` failed cycles in a row (tests shorten it). */
  retryDelay?: (failures: number) => number;
};

export type SessionSnapshot = {
  search: SearchState;
  /** Latest frame's detections for the overlay; empty when stopped. */
  detections: Detection[];
  frames: number;
  lastRttMs: number | null;
  p50RttMs: number | null;
  lastSamMs: number | null;
  /** The current failure streak's kind, or null while frames succeed. */
  failing: ErrorKind | null;
};

export type SearchController = {
  /** Starts (or replaces) the goal. Results for the previous goal are dropped. */
  start(concept: string, lang: Lang): void;
  stop(): void;
  /** Returns true when an active search was paused. */
  pause(): boolean;
  /** Returns true when a paused search resumed. */
  resume(): boolean;
  /** Stops all speech and empties the queue; the search itself goes on. */
  silence(): void;
  /** Speaks the last utterance again. Returns false when nothing was said yet. */
  repeat(): boolean;
  /** A spoken reply to the user (priority 0, not tied to a goal), e.g. the help line. */
  reply(key: string, text: string): void;
  /**
   * Unmount: stops the loop and all speech about the goal. A reply not tied to a goal ("Stopped
   * searching." from an Escape that also leaves the screen) still plays. The controller can start
   * again afterwards.
   */
  shutdown(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionSnapshot;
};

export function createSearchController(deps: ControllerDeps): SearchController {
  const options: LoopOptions = { ...LOOP, ...deps.loop };
  const retryDelay = deps.retryDelay ?? retryDelayMs;
  const announcer = deps.announcer ?? createAnnouncer(deps.speaker, { now: deps.now });
  const listeners = new Set<() => void>();

  let search: SearchState = initialSearchState();
  let loop: AbortController | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let nextFrameId = 0;
  let frames = 0;
  let metrics: FrameMetrics[] = [];
  let failures: FailureState = NO_FAILURES;
  let failureTotal = 0;
  let failing: ErrorKind | null = null;
  let detections: Detection[] = [];
  let snapshot = makeSnapshot();

  function makeSnapshot(): SessionSnapshot {
    const last = metrics[metrics.length - 1];
    const p50 = percentile(
      metrics.map((m) => m.rttMs),
      50,
    );
    return {
      search,
      detections,
      frames,
      lastRttMs: last?.rttMs ?? null,
      p50RttMs: p50 == null ? null : round(p50),
      lastSamMs: last?.samMs ?? null,
      failing,
    };
  }

  function publish() {
    snapshot = makeSnapshot();
    for (const listener of listeners) listener();
  }

  function dispatch(event: SearchEvent) {
    const now = deps.now();
    const { state, effects } = reduce(search, event, now);
    const changed = state !== search;
    if (state.status !== search.status && state.goal) {
      const sinceStart = state.startedAt == null ? null : now - state.startedAt;
      deps.log(statusLogLine(state.goal.concept, search.status, state.status, sinceStart));
    }
    search = state;
    runEffects(effects);
    if (changed) publish();
  }

  function runEffects(effects: readonly Effect[]) {
    for (const effect of effects) {
      if (effect.type === 'announce') {
        const { type: _type, ...announcement } = effect;
        announcer.announce(announcement);
      } else if (effect.type === 'haptic') {
        deps.haptic(effect.kind);
      }
    }
  }

  function logSummary(goal: Goal | null) {
    if (goal && frames + failureTotal > 0) {
      deps.log(metricsLogLine('stop', goal.concept, metrics, failureTotal));
    }
  }

  function startLoop(goal: Goal) {
    const controller = new AbortController();
    loop = controller;
    ticker = setInterval(() => dispatch({ type: 'tick' }), options.tickMs);
    void runLoop(goal, controller.signal);
  }

  function stopLoop() {
    loop?.abort();
    loop = null;
    if (ticker != null) clearInterval(ticker);
    ticker = null;
  }

  async function runLoop(goal: Goal, signal: AbortSignal) {
    while (!signal.aborted) {
      const startedAt = deps.now();
      const outcome = await runCycle(goal, signal, startedAt);
      if (signal.aborted) return;
      const wait = outcome.ok
        ? Math.max(0, options.minCycleMs - (deps.now() - startedAt))
        : withRetryAfter(retryDelay(failures.count), outcome.retryAfterMs);
      await sleep(wait, signal);
    }
  }

  /** One capture + one request. Never throws. */
  async function runCycle(goal: Goal, signal: AbortSignal, startedAt: number): Promise<CycleOutcome> {
    const frameId = nextFrameId++;
    let frame: FrameCapture;
    try {
      frame = await withAbortAndTimeout(
        deps.capture(signal),
        signal,
        options.captureTimeoutMs,
        `Capture timed out after ${options.captureTimeoutMs} ms`,
      );
    } catch (e) {
      if (!signal.aborted) fail(goal, 'camera', errorMessage(e));
      return { ok: false, retryAfterMs: null };
    }
    if (signal.aborted) return { ok: false, retryAfterMs: null };

    const sentAt = deps.now();
    let result: DetectResult;
    try {
      result = await deps.detect(
        { image_b64: frame.base64, concept: goal.concept, goal_id: goal.id, frame_id: frameId },
        signal,
      );
    } catch (e) {
      result = { ok: false, error: { kind: 'network', message: errorMessage(e) } };
    }
    // Stopped, paused or replaced by a new goal while the request was in flight: drop it.
    if (signal.aborted) return { ok: false, retryAfterMs: null };
    if (!result.ok) {
      const { error } = result;
      fail(goal, errorKindFor(error), describeError(error));
      return { ok: false, retryAfterMs: error.kind === 'http' ? (error.retryAfterMs ?? null) : null };
    }

    succeed(goal);
    const receivedAt = deps.now();
    const { data } = result;
    frames++;
    metrics.push({
      frameId,
      captureMs: frame.captureMs,
      processMs: frame.processMs,
      rttMs: round(receivedAt - sentAt),
      samMs: data.timings_ms?.sam ?? null,
      totalMs: round(receivedAt - startedAt),
      detections: data.detections.length,
      bestConfidence: data.detections[0]?.confidence ?? null,
    });
    if (metrics.length > options.maxMetrics) metrics = metrics.slice(-options.maxMetrics);
    if (data.goal_id === goal.id) detections = data.detections;
    dispatch({
      type: 'frame',
      result: {
        goalId: data.goal_id,
        frameId: data.frame_id,
        detections: data.detections,
        receivedAt,
      },
    });
    publish();
    if (frames % options.metricsEvery === 0) {
      deps.log(metricsLogLine('periodic', goal.concept, metrics, failureTotal));
    }
    return { ok: true };
  }

  function fail(goal: Goal, kind: ErrorKind, message: string) {
    failureTotal++;
    const result = recordFailure(failures, kind, deps.now());
    failures = result.state;
    failing = kind;
    dispatch({ type: 'outage' });
    deps.log(`[heynavi] frame failed (${kind}): ${message}`);
    if (result.announce) {
      announcer.announce({
        key: `error:${kind}`,
        priority: 2,
        text: phrases(goal.lang).error(kind),
        lang: goal.lang,
        ttlMs: 6000,
        dedupeMs: 0,
        goalId: goal.id,
      });
    }
    publish();
  }

  function succeed(goal: Goal) {
    const result = recordSuccess(failures);
    failures = result.state;
    failing = null;
    dispatch({ type: 'recovered' });
    if (result.reconnected) {
      announcer.announce({
        key: 'reconnected',
        priority: 2,
        text: phrases(goal.lang).reconnected(),
        lang: goal.lang,
        ttlMs: 4000,
        dedupeMs: 0,
        goalId: goal.id,
      });
    }
  }

  function resetSessionData() {
    nextFrameId = 0;
    frames = 0;
    metrics = [];
    failures = NO_FAILURES;
    failureTotal = 0;
    failing = null;
    detections = [];
  }

  return {
    start(concept, lang) {
      stopLoop();
      if (search.goal) logSummary(search.goal);
      const goal: Goal = { id: deps.newGoalId(), concept, label: conceptLabel(concept, lang), lang };
      // Stops anything still being said about the previous goal.
      announcer.setGoal(goal.id);
      resetSessionData();
      dispatch({ type: 'start', goal });
      startLoop(goal);
      publish();
    },

    stop() {
      if (search.status === 'IDLE' || search.status === 'CANCELLED') return;
      stopLoop();
      logSummary(search.goal);
      announcer.setGoal(null);
      detections = [];
      dispatch({ type: 'stop' });
      publish();
    },

    pause() {
      if (!isActive(search.status)) return false;
      stopLoop();
      announcer.clear();
      dispatch({ type: 'pause' });
      return true;
    },

    resume() {
      const goal = search.goal;
      if (search.status !== 'PAUSED' || !goal) return false;
      failures = NO_FAILURES;
      failing = null;
      dispatch({ type: 'resume' });
      startLoop(goal);
      return true;
    },

    silence() {
      announcer.clear();
    },

    repeat() {
      return announcer.repeat();
    },

    reply(key, text) {
      announcer.announce({
        key: `reply:${key}`,
        priority: 0,
        text,
        lang: 'en-US',
        ttlMs: SEARCH.ttlMs.reply,
        dedupeMs: 0,
        goalId: null,
      });
    },

    shutdown() {
      stopLoop();
      announcer.setGoal(null);
      if (search.status !== 'IDLE' && search.status !== 'CANCELLED') logSummary(search.goal);
      search = initialSearchState();
      resetSessionData();
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
