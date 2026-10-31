import { distanceM, snapToLine, type LatLon } from './geo.ts';
import type { Route } from './route.ts';

/** Tracker rules (ARCHITECTURE 8). Distances in meters, times in ms. */
export const TRACKER = {
  /** Say a step this far before it. */
  prepareM: 30,
  /** Say it again ("now") this close to it. */
  atStepM: 10,
  /** Mention the following step with this one when it comes this soon after. */
  thenWithinM: 40,
  /** Farther than this from the route (after crediting the GPS's own error, below) ... */
  offRouteM: 25,
  /** ... for this long means off the route. */
  offRouteMs: 10_000,
  /**
   * How much of the reported accuracy is credited when judging "off the route": a wide street's
   * sidewalk is 15–20 m from the map's line, plus the GPS error (first walk, 2026-10-30: 26–41 m
   * "off" at 6–16 m accuracy while on the right street).
   */
  offAccuracyCreditM: 15,
  /** No off-route judgment this soon after the route started (the start may be across a street). */
  offRouteGraceMs: 20_000,
  /** This close to the end: arrived. */
  arriveM: 15,
  /** No instructions while the reported horizontal accuracy is worse than this. */
  maxAccuracyM: 20,
  /** "The GPS signal is weak" at most this often. */
  weakGpsEveryMs: 45_000,
  /** Where along the route a new position may be matched, around the last progress. */
  lookBackM: 30,
  lookAheadM: 120,
} as const;

export type Fix = { at: number; point: LatLon; accuracyM: number | null };

export type TrackerEvent =
  /** `step` comes up in about `inM`. */
  | { type: 'prepare'; step: number; inM: number }
  /** At `step` now; `then` is the following step when it comes within `thenWithinM`. */
  | { type: 'step'; step: number; then: { step: number; inM: number } | null }
  | { type: 'off-route'; offM: number }
  | { type: 'arrived' }
  | { type: 'weak-gps'; accuracyM: number | null };

export type TrackerState = {
  /** Distance along the route of the last good position; null before the first one. */
  progressM: number | null;
  /** Distance from the route at the last good position. */
  offM: number | null;
  offSince: number | null;
  /** Steps already prepared for, and already said "now". */
  prepared: readonly number[];
  done: readonly number[];
  lastWeakAt: number | null;
  /** The last position was too inaccurate to use. */
  gpsWeak: boolean;
  arrived: boolean;
  /** Time of the first good position (the off-route grace period counts from it). */
  startedAt: number | null;
};

export const INITIAL_TRACKER: TrackerState = {
  progressM: null,
  offM: null,
  offSince: null,
  prepared: [],
  done: [],
  lastWeakAt: null,
  gpsWeak: false,
  arrived: false,
  startedAt: null,
};

/**
 * The tracker for a route that is just starting. The start line covers the beginning: steps at
 * the start are already said, and the first step within `prepareM` is already prepared for.
 */
export function startTracker(route: Route): TrackerState {
  const done: number[] = [];
  const prepared: number[] = [];
  route.steps.forEach((step, i) => {
    if (step.atM <= TRACKER.atStepM) done.push(i);
    if (step.atM <= TRACKER.prepareM) prepared.push(i);
  });
  return { ...INITIAL_TRACKER, done, prepared };
}

/** The first step the start line should mention, and how far along it is. */
export function firstStep(route: Route): { step: number; inM: number } | null {
  const i = route.steps.findIndex((step) => step.atM > TRACKER.atStepM && step.maneuver !== 'arrive');
  return i < 0 ? null : { step: i, inM: route.steps[i].atM };
}

/**
 * One position update: where the walker is on the route and what to say. Pure. Instructions
 * only while the position is accurate enough; a step that was passed without being said (a GPS
 * jump) is skipped, never said late.
 */
export function track(route: Route, state: TrackerState, fix: Fix): { state: TrackerState; events: TrackerEvent[] } {
  if (state.arrived) return { state, events: [] };

  if (fix.accuracyM == null || fix.accuracyM > TRACKER.maxAccuracyM) {
    const due = state.lastWeakAt == null || fix.at - state.lastWeakAt >= TRACKER.weakGpsEveryMs;
    return {
      state: { ...state, gpsWeak: true, offSince: null, lastWeakAt: due ? fix.at : state.lastWeakAt },
      events: due ? [{ type: 'weak-gps', accuracyM: fix.accuracyM }] : [],
    };
  }

  // Match near the last progress first; anywhere on the route only when that fails.
  const from = state.progressM == null ? 0 : state.progressM - TRACKER.lookBackM;
  const to = state.progressM == null ? TRACKER.lookAheadM : state.progressM + TRACKER.lookAheadM;
  let snap = snapToLine(route.points, route.cumulative, fix.point, from, to);
  if (!snap || snap.offM > TRACKER.offRouteM) {
    const anywhere = snapToLine(route.points, route.cumulative, fix.point);
    if (anywhere && (!snap || anywhere.offM < snap.offM)) snap = anywhere;
  }
  if (!snap) return { state, events: [] };

  const events: TrackerEvent[] = [];
  const startedAt = state.startedAt ?? fix.at;
  let next: TrackerState = { ...state, gpsWeak: false, offM: snap.offM, startedAt };

  // Arrived: near the end of the route, or near its last point however the route was matched.
  const end = route.points[route.points.length - 1];
  if (route.lengthM - snap.alongM <= TRACKER.arriveM || distanceM(fix.point, end) <= TRACKER.arriveM) {
    return { state: { ...next, progressM: snap.alongM, arrived: true, offSince: null }, events: [{ type: 'arrived' }] };
  }

  // Off the route: far from it (beyond the GPS's own error) for long enough, after the grace
  // period. Progress is not updated from a far position.
  const off = snap.offM - Math.min(fix.accuracyM, TRACKER.offAccuracyCreditM);
  if (off > TRACKER.offRouteM) {
    if (fix.at - startedAt < TRACKER.offRouteGraceMs) return { state: next, events: [] };
    const since = state.offSince ?? fix.at;
    if (fix.at - since >= TRACKER.offRouteMs) {
      return { state: { ...next, offSince: null }, events: [{ type: 'off-route', offM: snap.offM }] };
    }
    return { state: { ...next, offSince: since }, events: [] };
  }
  next = { ...next, offSince: null, progressM: snap.alongM };
  const progress = snap.alongM;

  const prepared = new Set(state.prepared);
  const done = new Set(state.done);
  route.steps.forEach((step, i) => {
    // Passed without being said (or the start of the route): never said late.
    if (step.atM < progress - TRACKER.atStepM && !done.has(i)) {
      done.add(i);
      prepared.add(i);
    }
  });

  const upcoming = route.steps.findIndex((step, i) => !done.has(i) && step.maneuver !== 'arrive');
  if (upcoming >= 0) {
    const inM = route.steps[upcoming].atM - progress;
    if (inM <= TRACKER.atStepM) {
      done.add(upcoming);
      prepared.add(upcoming);
      const following = upcoming + 1 < route.steps.length ? upcoming + 1 : -1;
      const thenInM = following >= 0 ? route.steps[following].atM - progress : Number.POSITIVE_INFINITY;
      const then =
        following >= 0 && route.steps[following].maneuver !== 'arrive' && thenInM <= TRACKER.thenWithinM
          ? { step: following, inM: thenInM }
          : null;
      if (then) prepared.add(then.step);
      events.push({ type: 'step', step: upcoming, then });
    } else if (inM <= TRACKER.prepareM && !prepared.has(upcoming)) {
      prepared.add(upcoming);
      events.push({ type: 'prepare', step: upcoming, inM });
    }
  }

  return { state: { ...next, prepared: [...prepared], done: [...done] }, events };
}

/** The next step to take and how far it is, for "what's next" and the route card. */
export function nextStep(route: Route, state: TrackerState): { step: number; inM: number | null } | null {
  const progress = state.progressM ?? 0;
  const i = route.steps.findIndex((step, index) => !state.done.includes(index) && step.atM >= progress - TRACKER.atStepM);
  if (i < 0) return null;
  return { step: i, inM: state.progressM == null ? null : Math.max(0, route.steps[i].atM - progress) };
}

/** Meters left to the end of the route; null before the first good position. */
export function remainingM(route: Route, state: TrackerState): number | null {
  return state.progressM == null ? null : Math.max(0, route.lengthM - state.progressM);
}
