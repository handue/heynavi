import { distanceM, type LatLon } from './geo.ts';
import { buildRoute, turnCount, type MapKitRoute, type Maneuver, type Route } from './route.ts';
import { instructionText, routePhrases, startDirection } from './route-phrases.ts';
import { firstStep, nextStep, remainingM, startTracker, track, type Fix, type TrackerEvent, type TrackerState } from './route-tracker.ts';

/** Apple MapKit on the phone (modules/heynavi-maps). */
export type MapsPort = {
  searchPlaces(query: string, latitude: number, longitude: number, radiusMeters: number): Promise<{ name: string; latitude: number; longitude: number }[]>;
  walkingRoute(fromLatitude: number, fromLongitude: number, toLatitude: number, toLongitude: number): Promise<MapKitRoute>;
  reverseGeocode(latitude: number, longitude: number): Promise<{ name?: string; street?: string; area?: string; city?: string }>;
};

/** GPS and compass (expo-location). */
export type LocationPort = {
  /** False when HeyNavi may not use the location. */
  requestPermission(): Promise<boolean>;
  /** Position about once a second, and the compass heading (null while it is unreliable). */
  watch(onFix: (fix: Fix) => void, onHeading: (degrees: number | null) => void): Promise<() => void>;
};

/** A line to speak: `route` lines are the route's own channel; `reply` answers the user. */
export type RouteLine = { key: string; text: string; kind: 'route' | 'reply'; ttlMs: number };

export type NavigationDeps = {
  maps: MapsPort | null;
  location: LocationPort | null;
  say(line: RouteLine): void;
  now(): number;
  /** Metrics, uploaded to the backend: distances and accuracy only, never coordinates or places. */
  log(line: string): void;
  /** Development log: may name places and instructions. */
  devLog?(line: string): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type NavigationStatus = 'idle' | 'locating' | 'searching' | 'routing' | 'navigating' | 'rerouting' | 'arrived';

export type NavigationSnapshot = {
  status: NavigationStatus;
  /** What the user asked for, then the place found. */
  destination: string | null;
  next: { instruction: string; maneuver: Maneuver; inM: number | null } | null;
  leftM: number | null;
  gpsWeak: boolean;
};

export type NavigationController = {
  /** "Navigate to <query>": finds the nearest match on the map and starts a walking route. */
  start(query: string): Promise<void>;
  /** "Stop navigation". */
  stop(): void;
  /** "What's next": the next step and what is left. */
  whatsNext(): void;
  /** "Where am I": the street and area from the map. */
  whereAmI(): Promise<void>;
  /** Stops everything without speaking (the session closed). */
  shutdown(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): NavigationSnapshot;
};

/** Places farther than this are not offered for a walk. */
const SEARCH_RADIUS_M = 3000;
const MAX_WALK_M = 5000;
/** The first position used to search must be at least this good. */
const FIRST_FIX_ACCURACY_M = 50;
const FIRST_FIX_TIMEOUT_MS = 15_000;
/** A position older than this is not "where you are". */
const FRESH_FIX_MS = 10_000;
/** The route card shows the arrival this long. */
const ARRIVED_SHOWN_MS = 15_000;
/**
 * At most one re-route this often: a re-routed line that is still "off" (a wide street) must not
 * loop "Recalculating" every 15 s (first walk, 2026-10-30).
 */
const REROUTE_COOLDOWN_MS = 45_000;

const IDLE: NavigationSnapshot = { status: 'idle', destination: null, next: null, leftM: null, gpsWeak: false };

/**
 * Walking navigation (ARCHITECTURE 8): MapKit finds the place and the route, the tracker says each
 * step from the GPS, and the camera keeps running beside it. Location is watched only while a
 * route is being prepared or followed (or for one "where am I").
 */
export function createNavigationController(deps: NavigationDeps): NavigationController {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let snapshot = IDLE;
  /** Bumped by every start, stop and shutdown: async work of an older one is dropped. */
  let generation = 0;
  let status: NavigationStatus = 'idle';
  let query: string | null = null;
  let place: { name: string; point: LatLon } | null = null;
  let route: Route | null = null;
  let tracker: TrackerState | null = null;
  let lastFix: Fix | null = null;
  let heading: number | null = null;
  let stopWatching: (() => void) | null = null;
  let watching: Promise<void> | null = null;
  let fixWaiters: ((fix: Fix) => void)[] = [];
  let arrivedTimer: unknown = null;
  let routeStartedAt = 0;
  let reroutes = 0;
  let lastRerouteAt: number | null = null;

  function publish() {
    const next = route && tracker ? nextStep(route, tracker) : null;
    const step = next && route ? route.steps[next.step] : null;
    snapshot = {
      status,
      destination: place?.name ?? query,
      next: step ? { instruction: instructionText(step), maneuver: step.maneuver, inM: next?.inM ?? null } : null,
      leftM: route && tracker ? remainingM(route, tracker) : null,
      gpsWeak: tracker?.gpsWeak ?? false,
    };
    for (const listener of listeners) listener();
  }

  function setStatus(next: NavigationStatus) {
    status = next;
    publish();
  }

  function say(key: string, text: string, kind: RouteLine['kind'] = 'route', ttlMs = 8000) {
    deps.say({ key, text, kind, ttlMs });
  }

  function metric(fields: Record<string, unknown>) {
    deps.log(`[heynavi-metrics] ${JSON.stringify({ reason: 'route', ...fields })}`);
  }

  function onFix(fix: Fix) {
    lastFix = fix;
    const waiters = fixWaiters;
    fixWaiters = [];
    for (const waiter of waiters) waiter(fix);
    if (status !== 'navigating' || !route || !tracker) return;
    const out = track(route, tracker, fix);
    tracker = out.state;
    for (const event of out.events) handle(event, fix);
    publish();
  }

  async function ensureWatching(): Promise<boolean> {
    if (stopWatching) return true;
    if (!deps.location) return false;
    watching ??= deps.location
      .watch(onFix, (degrees) => {
        heading = degrees;
      })
      .then((stop) => {
        stopWatching = stop;
      })
      .finally(() => {
        watching = null;
      });
    await watching;
    return stopWatching != null;
  }

  function endWatching() {
    stopWatching?.();
    stopWatching = null;
    fixWaiters = [];
    lastFix = null;
  }

  /** The next position at least `accuracyM` good, or null after `timeoutMs`. */
  function goodFix(accuracyM: number, timeoutMs: number): Promise<Fix | null> {
    const recent = lastFix;
    if (recent && deps.now() - recent.at <= FRESH_FIX_MS && recent.accuracyM != null && recent.accuracyM <= accuracyM) {
      return Promise.resolve(recent);
    }
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        fixWaiters = fixWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (fix: Fix) => {
        if (fix.accuracyM != null && fix.accuracyM <= accuracyM) {
          clearTimer(timer);
          resolve(fix);
        } else {
          fixWaiters.push(waiter);
        }
      };
      fixWaiters.push(waiter);
    });
  }

  function reset() {
    generation++;
    if (arrivedTimer != null) clearTimer(arrivedTimer);
    arrivedTimer = null;
    endWatching();
    status = 'idle';
    query = null;
    place = null;
    route = null;
    tracker = null;
    reroutes = 0;
    lastRerouteAt = null;
  }

  async function routeTo(gen: number, from: LatLon, why: 'start' | 'reroute'): Promise<void> {
    const target = place;
    const maps = deps.maps;
    if (!target || !maps) return;
    const sentAt = deps.now();
    let map: MapKitRoute;
    try {
      map = await maps.walkingRoute(from.lat, from.lon, target.point.lat, target.point.lon);
    } catch (error) {
      if (gen !== generation) return;
      metric({ event: 'no-route', why, routeMs: Math.round(deps.now() - sentAt) });
      deps.devLog?.(`[heynavi-route] no route to ${target.name}: ${String(error)}`);
      say('route:no-route', routePhrases.noRoute(target.name), 'reply');
      reset();
      publish();
      return;
    }
    if (gen !== generation) return;
    route = buildRoute(map, target.name);
    tracker = startTracker(route);
    status = 'navigating';
    const turns = turnCount(route);
    metric({ event: why, lengthM: Math.round(route.lengthM), steps: route.steps.length, turns, routeMs: Math.round(deps.now() - sentAt) });
    deps.devLog?.(`[heynavi-route] ${why} to ${target.name}: ${route.steps.map((s) => `${Math.round(s.atM)}m ${s.instruction}`).join(' | ')}`);
    if (why === 'start') {
      routeStartedAt = deps.now();
      const first = firstStep(route);
      say(
        'route:start',
        routePhrases.start(
          target.name,
          route.lengthM,
          turns,
          startDirection(route.startBearingDeg, heading, route.startStreet),
          first ? { step: route.steps[first.step], inM: first.inM } : null,
        ),
        'route',
        12_000,
      );
    } else {
      say(`route:rerouted:${reroutes}`, routePhrases.rerouted(route.lengthM));
    }
    publish();
  }

  function handle(event: TrackerEvent, fix: Fix) {
    if (!route) return;
    const accuracyM = fix.accuracyM == null ? null : Math.round(fix.accuracyM);
    switch (event.type) {
      case 'prepare':
        metric({ event: 'prepare', step: event.step, inM: Math.round(event.inM), accuracyM });
        say(`route:prepare:${event.step}`, routePhrases.prepare(route.steps[event.step], event.inM), 'route', 6000);
        break;
      case 'step': {
        const then = event.then ? { step: route.steps[event.then.step], inM: event.then.inM } : null;
        metric({ event: 'step', step: event.step, offM: Math.round(tracker?.offM ?? 0), accuracyM });
        say(`route:step:${event.step}`, routePhrases.step(route.steps[event.step], then), 'route', 5000);
        break;
      }
      case 'weak-gps':
        metric({ event: 'weak-gps', accuracyM: event.accuracyM == null ? null : Math.round(event.accuracyM) });
        say(`route:weak-gps:${Math.round(fix.at)}`, routePhrases.weakGps(), 'route', 5000);
        break;
      case 'off-route': {
        if (lastRerouteAt != null && deps.now() - lastRerouteAt < REROUTE_COOLDOWN_MS) {
          metric({ event: 'off-route-held', offM: Math.round(event.offM), accuracyM });
          break;
        }
        metric({ event: 'off-route', offM: Math.round(event.offM), accuracyM });
        lastRerouteAt = deps.now();
        reroutes++;
        status = 'rerouting';
        say(`route:off:${reroutes}`, routePhrases.offRoute(), 'route', 6000);
        void routeTo(generation, fix.point, 'reroute');
        break;
      }
      case 'arrived': {
        metric({ event: 'arrived', walkedS: Math.round((deps.now() - routeStartedAt) / 1000), reroutes, accuracyM });
        status = 'arrived';
        say('route:arrived', routePhrases.arrived(route.destination), 'route', 10_000);
        endWatching();
        const gen = generation;
        arrivedTimer = setTimer(() => {
          if (gen !== generation) return;
          reset();
          publish();
        }, ARRIVED_SHOWN_MS);
        break;
      }
    }
  }

  return {
    async start(destination) {
      reset();
      const gen = generation;
      query = destination;
      if (!deps.maps || !deps.location) {
        say('route:unavailable', routePhrases.unavailable(), 'reply');
        reset();
        publish();
        return;
      }
      if (!(await deps.location.requestPermission())) {
        if (gen !== generation) return;
        say('route:denied', routePhrases.locationDenied(), 'reply');
        reset();
        publish();
        return;
      }
      if (gen !== generation) return;
      setStatus('locating');
      say('route:locating', routePhrases.locating(), 'reply', 5000);
      const startedAt = deps.now();
      if (!(await ensureWatching())) {
        if (gen !== generation) return;
        say('route:no-location', routePhrases.noLocation(), 'reply');
        reset();
        publish();
        return;
      }
      const fix = await goodFix(FIRST_FIX_ACCURACY_M, FIRST_FIX_TIMEOUT_MS);
      if (gen !== generation) return;
      if (!fix) {
        metric({ event: 'no-location', waitedMs: Math.round(deps.now() - startedAt) });
        say('route:no-location', routePhrases.noLocation(), 'reply');
        reset();
        publish();
        return;
      }
      setStatus('searching');
      say('route:searching', routePhrases.searching(destination), 'reply', 5000);
      const searchAt = deps.now();
      let found: { name: string; latitude: number; longitude: number }[];
      try {
        found = await deps.maps.searchPlaces(destination, fix.point.lat, fix.point.lon, SEARCH_RADIUS_M);
      } catch {
        found = [];
      }
      if (gen !== generation) return;
      const nearest = found
        .map((p) => ({ name: p.name, point: { lat: p.latitude, lon: p.longitude } }))
        .map((p) => ({ ...p, distance: distanceM(fix.point, p.point) }))
        .filter((p) => p.distance <= MAX_WALK_M)
        .sort((a, b) => a.distance - b.distance)[0];
      metric({
        event: 'search',
        results: found.length,
        nearestM: nearest ? Math.round(nearest.distance) : null,
        searchMs: Math.round(deps.now() - searchAt),
        fixMs: Math.round(searchAt - startedAt),
        accuracyM: fix.accuracyM == null ? null : Math.round(fix.accuracyM),
      });
      if (!nearest) {
        say('route:not-found', routePhrases.notFound(destination), 'reply');
        reset();
        publish();
        return;
      }
      place = { name: nearest.name, point: nearest.point };
      setStatus('routing');
      await routeTo(gen, fix.point, 'start');
    },

    stop() {
      if (status === 'idle') {
        say('route:not-navigating', routePhrases.notNavigating(), 'reply');
        return;
      }
      metric({ event: 'stopped', walkedS: routeStartedAt ? Math.round((deps.now() - routeStartedAt) / 1000) : 0 });
      reset();
      say('route:ended', routePhrases.ended(), 'reply', 5000);
      publish();
    },

    whatsNext() {
      if (!route || !tracker || status === 'idle') {
        say('route:not-navigating', routePhrases.notNavigating(), 'reply');
        return;
      }
      const next = nextStep(route, tracker);
      const text = routePhrases.next(next ? route.steps[next.step] : null, next?.inM ?? null, route.destination, remainingM(route, tracker));
      say(`route:next:${Math.round(deps.now())}`, tracker.gpsWeak ? `${text} ${routePhrases.weakGps()}` : text, 'reply');
    },

    async whereAmI() {
      if (!deps.maps || !deps.location) {
        say('route:unavailable', routePhrases.unavailable(), 'reply');
        return;
      }
      const gen = generation;
      const temporary = !stopWatching;
      if (!(await deps.location.requestPermission())) {
        say('route:denied', routePhrases.locationDenied(), 'reply');
        return;
      }
      if (!(await ensureWatching())) {
        say('route:no-location', routePhrases.noLocation(), 'reply');
        return;
      }
      const fix = await goodFix(FIRST_FIX_ACCURACY_M, FIRST_FIX_TIMEOUT_MS);
      if (temporary && gen === generation && status === 'idle') endWatching();
      if (!fix) {
        say('route:no-location', routePhrases.noLocation(), 'reply');
        return;
      }
      let address: Awaited<ReturnType<MapsPort['reverseGeocode']>> = {};
      try {
        address = await deps.maps.reverseGeocode(fix.point.lat, fix.point.lon);
      } catch {
        address = {};
      }
      const following = route && tracker && status === 'navigating' ? { place: route.destination, leftM: remainingM(route, tracker) } : null;
      metric({ event: 'where-am-i', street: Boolean(address.street), accuracyM: fix.accuracyM == null ? null : Math.round(fix.accuracyM) });
      say(`route:where:${Math.round(deps.now())}`, routePhrases.whereAmI(address, following), 'reply');
    },

    shutdown() {
      reset();
      publish();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,
  };
}
