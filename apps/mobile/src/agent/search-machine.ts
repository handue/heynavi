/**
 * Active Object Search state machine (ARCHITECTURE 5.1) as a pure reducer:
 * (state, event, now) -> { state, effects }. The session runs the effects (speech, haptics).
 *
 * FOUND and LOST are transient: they are reported for one frame, and the next frame is handled
 * as GUIDING and SEARCHING respectively.
 */
import { CONFIRM, candidates, confirm, largest, meets, nearestCandidate } from './confirm.ts';
import { phrases, type SizeHint } from './phrases.ts';
import type {
  AnnounceEffect,
  Detection,
  Effect,
  FrameResult,
  Goal,
  Priority,
  SearchState,
  SearchStatus,
} from './types.ts';

export const SEARCH = {
  /** CONFIRMING -> SEARCHING after this many frames in a row without a candidate. */
  confirmMisses: 2,
  /** GUIDING -> LOST after this many frames in a row without a candidate. */
  lostMisses: 3,
  /** Position updates while guiding are spoken at most this often. */
  guideMinIntervalMs: 2500,
  /**
   * First coaching prompt after this long without a confirm-strength candidate, then every
   * coachRepeatMs. A weak candidate that never confirms must not keep the user in silence.
   */
  coachFirstMs: 10_000,
  coachRepeatMs: 15_000,
  /** One check-in after this long without a candidate. */
  checkInMs: 60_000,
  /** Box area (fraction of the frame) above which it "looks close", below which "far away". */
  closeArea: 0.25,
  farArea: 0.03,
  ttlMs: { reply: 5000, goalEvent: 4000, guide: 2000, status: 6000 },
  dedupeMs: { found: 20_000, status: 15_000 },
} as const;

export type SearchEvent =
  | { type: 'start'; goal: Goal }
  | { type: 'frame'; result: FrameResult }
  | { type: 'tick' }
  /** A frame failed (camera or server): no evidence, so no coaching until frames succeed. */
  | { type: 'outage' }
  | { type: 'recovered' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export type Transition = { state: SearchState; effects: Effect[] };

/** Statuses in which frames are processed and the camera loop runs. */
const ACTIVE: ReadonlySet<SearchStatus> = new Set([
  'SEARCHING',
  'CONFIRMING',
  'FOUND',
  'GUIDING',
  'LOST',
]);

/** Statuses in which coaching prompts play when nothing has been confirmed for a while. */
const COACHED: ReadonlySet<SearchStatus> = new Set(['SEARCHING', 'CONFIRMING', 'LOST']);

export function isActive(status: SearchStatus): boolean {
  return ACTIVE.has(status);
}

export function initialSearchState(): SearchState {
  return {
    status: 'IDLE',
    goal: null,
    window: [],
    misses: 0,
    startedAt: null,
    lastCandidateAt: null,
    nextCoachingAt: null,
    coachingCount: 0,
    checkInDone: false,
    trackX: null,
    position: null,
    spokenPosition: null,
    spokenPositionAt: null,
    foundAt: null,
    episode: 0,
    outageSince: null,
  };
}

export function sizeHint(area: number): SizeHint {
  if (area > SEARCH.closeArea) return 'close';
  if (area < SEARCH.farArea) return 'far';
  return null;
}

export function reduce(state: SearchState, event: SearchEvent, now: number): Transition {
  switch (event.type) {
    case 'start':
      return {
        state: searching(event.goal, now),
        effects: [
          say(event.goal, `start:${event.goal.id}`, 0, phrases(event.goal.lang).start(event.goal.concept), {
            ttlMs: SEARCH.ttlMs.reply,
          }),
        ],
      };
    case 'frame':
      return onFrame(state, event.result, now);
    case 'tick':
      return COACHED.has(state.status) && state.outageSince == null
        ? maybeCoach(state, now)
        : unchanged(state);
    case 'outage':
      return isActive(state.status) && state.outageSince == null
        ? { state: { ...state, outageSince: now }, effects: [] }
        : unchanged(state);
    case 'recovered':
      return state.outageSince == null ? unchanged(state) : { state: afterOutage(state, now), effects: [] };
    case 'pause':
      return isActive(state.status) ? { state: { ...state, status: 'PAUSED' }, effects: [] } : unchanged(state);
    case 'resume': {
      const goal = state.goal;
      if (state.status !== 'PAUSED' || !goal) return unchanged(state);
      return {
        // A new episode: the user hears "Looking again", so a re-find must be spoken.
        state: { ...searching(goal, now), episode: state.episode + 1 },
        effects: [
          say(goal, `resume:${goal.id}`, 1, phrases(goal.lang).resume(goal.concept), {
            ttlMs: SEARCH.ttlMs.goalEvent,
          }),
        ],
      };
    }
    case 'stop': {
      if (state.status === 'IDLE' || state.status === 'CANCELLED') return unchanged(state);
      const lang = state.goal?.lang ?? 'en-US';
      return {
        state: { ...initialSearchState(), status: 'CANCELLED' },
        effects: [
          {
            type: 'announce',
            key: 'stop',
            priority: 0,
            text: phrases(lang).stop(),
            lang,
            ttlMs: SEARCH.ttlMs.reply,
            dedupeMs: 0,
            // Not tied to the goal: it must survive the goal being cleared.
            goalId: null,
          },
        ],
      };
    }
  }
}

function unchanged(state: SearchState): Transition {
  return { state, effects: [] };
}

/** Fresh SEARCHING state for `goal`: empty evidence, coaching timers from `now`. */
function searching(goal: Goal, now: number): SearchState {
  return {
    ...initialSearchState(),
    status: 'SEARCHING',
    goal,
    startedAt: now,
    nextCoachingAt: now + SEARCH.coachFirstMs,
  };
}

/**
 * The outage time does not count as searching: coaching and the check-in move by that much.
 * Frames from before the outage no longer describe what the camera sees, so they are dropped
 * and cannot help confirm a candidate; a half-confirmed candidate goes back to SEARCHING.
 */
function afterOutage(state: SearchState, now: number): SearchState {
  const shift = now - (state.outageSince ?? now);
  const moved = (t: number | null) => (t == null ? null : t + shift);
  return {
    ...state,
    status: state.status === 'CONFIRMING' ? 'SEARCHING' : state.status,
    window: [],
    outageSince: null,
    startedAt: moved(state.startedAt),
    lastCandidateAt: moved(state.lastCandidateAt),
    nextCoachingAt: moved(state.nextCoachingAt),
  };
}

function onFrame(state: SearchState, result: FrameResult, now: number): Transition {
  // Results for an old goal, or arriving while paused or stopped, are ignored.
  if (!state.goal || result.goalId !== state.goal.id || !isActive(state.status)) {
    return unchanged(state);
  }
  const found = candidates(result.detections, CONFIRM.tauDetect);
  if (state.status === 'FOUND' || state.status === 'GUIDING') {
    return onGuideFrame(state, state.goal, found, now);
  }
  return onSearchFrame(state, state.goal, found, now);
}

/** A confirm-strength candidate (or a tracked match) resets the coaching and check-in timers. */
function withCandidate(state: SearchState, now: number): SearchState {
  return {
    ...state,
    misses: 0,
    lastCandidateAt: now,
    nextCoachingAt: now + SEARCH.coachFirstMs,
    coachingCount: 0,
    checkInDone: false,
  };
}

function onSearchFrame(state: SearchState, goal: Goal, found: Detection[], now: number): Transition {
  const window = [...state.window, found].slice(-CONFIRM.windowSize);
  const status = state.status === 'LOST' ? 'SEARCHING' : state.status;

  if (found.length === 0) {
    if (status === 'CONFIRMING') {
      const misses = state.misses + 1;
      return misses >= SEARCH.confirmMisses
        ? maybeCoach({ ...state, status: 'SEARCHING', window, misses: 0 }, now)
        : { state: { ...state, status: 'CONFIRMING', window, misses }, effects: [] };
    }
    return maybeCoach({ ...state, status: 'SEARCHING', window }, now);
  }

  const strong = found.filter((d) => meets(d, CONFIRM.tauConfirm));
  // A weak candidate keeps CONFIRMING alive but does not hold back coaching.
  const next = strong.length > 0 ? withCandidate({ ...state, window }, now) : { ...state, window, misses: 0 };
  const confirmation = confirm(window);
  if (!confirmation) return { state: { ...next, status: 'CONFIRMING' }, effects: [] };

  // Several confident instances: talk about (and then track) the largest one.
  const target = strong.length >= 2 ? largest(strong)! : confirmation.detection;
  const p = phrases(goal.lang);
  const text =
    strong.length >= 2
      ? p.foundMany(goal.concept, strong.length, target.position, sizeHint(target.area))
      : p.found(goal.concept, target.position, sizeHint(target.area));
  return {
    state: {
      ...next,
      status: 'FOUND',
      foundAt: now,
      trackX: target.center_x,
      position: target.position,
      spokenPosition: target.position,
      spokenPositionAt: now,
    },
    effects: [
      say(goal, `found:${goal.id}:${state.episode}:${target.position}`, 1, text, {
        ttlMs: SEARCH.ttlMs.goalEvent,
        dedupeMs: SEARCH.dedupeMs.found,
      }),
      { type: 'haptic', kind: 'found' },
    ],
  };
}

function onGuideFrame(state: SearchState, goal: Goal, found: Detection[], now: number): Transition {
  const match = nearestCandidate(found, state.trackX, CONFIRM.tauDetect);
  if (!match) {
    const misses = state.misses + 1;
    if (misses < SEARCH.lostMisses) {
      return { state: { ...state, status: 'GUIDING', misses }, effects: [] };
    }
    return {
      state: {
        ...state,
        status: 'LOST',
        window: [],
        misses: 0,
        trackX: null,
        position: null,
        spokenPosition: null,
        spokenPositionAt: null,
        foundAt: null,
        episode: state.episode + 1,
      },
      effects: [
        say(goal, `lost:${goal.id}:${state.episode}`, 1, phrases(goal.lang).lost(goal.concept), {
          ttlMs: SEARCH.ttlMs.goalEvent,
          dedupeMs: SEARCH.dedupeMs.status,
        }),
      ],
    };
  }

  const effects: Effect[] = [];
  if (match.position === 'center' && state.position !== 'center') {
    effects.push({ type: 'haptic', kind: 'centered' });
  }
  let { spokenPosition, spokenPositionAt } = state;
  if (
    match.position !== spokenPosition &&
    (spokenPositionAt == null || now - spokenPositionAt >= SEARCH.guideMinIntervalMs)
  ) {
    effects.push(
      say(goal, `guide:${goal.id}`, 2, phrases(goal.lang).guide(match.position), {
        ttlMs: SEARCH.ttlMs.guide,
      }),
    );
    spokenPosition = match.position;
    spokenPositionAt = now;
  }
  return {
    state: {
      ...withCandidate(state, now),
      status: 'GUIDING',
      trackX: match.center_x,
      position: match.position,
      spokenPosition,
      spokenPositionAt,
    },
    effects,
  };
}

/**
 * Coaching after coachFirstMs without a candidate, then every coachRepeatMs, and one check-in
 * at checkInMs. A prompt that would land just before the check-in waits for it instead.
 */
function maybeCoach(state: SearchState, now: number): Transition {
  const goal = state.goal;
  if (!goal || state.nextCoachingAt == null || now < state.nextCoachingAt) return unchanged(state);
  const since = state.lastCandidateAt ?? state.startedAt ?? now;
  const checkInAt = since + SEARCH.checkInMs;
  const p = phrases(goal.lang);

  if (!state.checkInDone && now >= checkInAt) {
    return {
      state: { ...state, checkInDone: true, nextCoachingAt: now + SEARCH.coachRepeatMs },
      effects: [
        say(goal, `checkin:${goal.id}`, 2, p.checkIn(goal.concept), {
          ttlMs: SEARCH.ttlMs.status,
          dedupeMs: SEARCH.dedupeMs.status,
        }),
      ],
    };
  }

  let nextCoachingAt = now + SEARCH.coachRepeatMs;
  if (!state.checkInDone && nextCoachingAt > checkInAt - SEARCH.coachRepeatMs) {
    nextCoachingAt = Math.max(checkInAt, now);
  }
  return {
    state: { ...state, coachingCount: state.coachingCount + 1, nextCoachingAt },
    effects: [
      // One key per prompt, so a late prompt never dedupes the next one.
      say(goal, `coach:${goal.id}:${state.coachingCount}`, 2, p.coaching(goal.concept, state.coachingCount), {
        ttlMs: SEARCH.ttlMs.status,
        dedupeMs: SEARCH.dedupeMs.status,
      }),
    ],
  };
}

function say(
  goal: Goal,
  key: string,
  priority: Priority,
  text: string,
  options: { ttlMs: number; dedupeMs?: number },
): AnnounceEffect {
  return {
    type: 'announce',
    key,
    priority,
    text,
    lang: goal.lang,
    ttlMs: options.ttlMs,
    dedupeMs: options.dedupeMs ?? 0,
    goalId: goal.id,
  };
}
