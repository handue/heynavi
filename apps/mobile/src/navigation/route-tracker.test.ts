/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyze, parse } from '../voice/command-grammar.ts';
import { bearingDeg, distanceM, type LatLon } from './geo.ts';
import { buildRoute, maneuverOf, turnCount, type MapKitRoute } from './route.ts';
import { aboutDistance, instructionText, routePhrases, startDirection } from './route-phrases.ts';
import { INITIAL_TRACKER, TRACKER, firstStep, nextStep, remainingM, startTracker, track, type Fix, type TrackerEvent, type TrackerState } from './route-tracker.ts';

/** Seoul City Hall, a public landmark (the routing check used it too). */
const ORIGIN: LatLon = { lat: 37.5663, lon: 126.9779 };
const M_PER_DEG_LAT = 111_195;

function offset(northM: number, eastM: number): LatLon {
  return { lat: ORIGIN.lat + northM / M_PER_DEG_LAT, lon: ORIGIN.lon + eastM / (M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)) };
}

/** 100 m north, turn right, 100 m east: MapKit's shape, with its empty first instruction. */
function lRoute(): MapKitRoute {
  const leg = (from: [number, number], to: [number, number]) =>
    Array.from({ length: 11 }, (_, i) => {
      const p = offset(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
      return [p.lat, p.lon] as [number, number];
    });
  return {
    distance: 200,
    steps: [
      { instructions: '', notice: '', distance: 0, points: [[ORIGIN.lat, ORIGIN.lon]] },
      { instructions: 'Head north', notice: '', distance: 100, points: leg([0, 0], [100, 0]) },
      { instructions: 'Turn right onto Test-ro', notice: '', distance: 100, points: leg([100, 0], [100, 100]) },
      { instructions: 'The destination is on your right', notice: '', distance: 0, points: [leg([100, 0], [100, 100])[10]] },
    ],
  };
}

/** Walks a list of points, one fix a second, and collects what the tracker says. */
function walk(points: LatLon[], accuracyM: number | null = 5, start?: TrackerState) {
  const route = buildRoute(lRoute(), 'Test Cafe');
  let state = start ?? startTracker(route);
  const events: (TrackerEvent & { at: number })[] = [];
  points.forEach((point, i) => {
    const fix: Fix = { at: i * 1000, point, accuracyM };
    const out = track(route, state, fix);
    state = out.state;
    events.push(...out.events.map((e) => ({ ...e, at: i })));
  });
  return { route, state, events };
}

/** The L route walked in 5 m steps. */
function alongL(): LatLon[] {
  const pts: LatLon[] = [];
  for (let n = 0; n <= 100; n += 5) pts.push(offset(n, 0));
  for (let e = 5; e <= 100; e += 5) pts.push(offset(100, e));
  return pts;
}

describe('geo', () => {
  it('measures meters and bearings', () => {
    assert.ok(Math.abs(distanceM(offset(0, 0), offset(100, 0)) - 100) < 0.5);
    assert.ok(Math.abs(bearingDeg(offset(0, 0), offset(100, 0)) - 0) < 0.5);
    assert.ok(Math.abs(bearingDeg(offset(0, 0), offset(0, 100)) - 90) < 0.5);
  });
});

describe('route', () => {
  it('places each instruction where its step starts and skips the empty first one', () => {
    const route = buildRoute(lRoute(), 'Test Cafe');
    assert.ok(Math.abs(route.lengthM - 200) < 1);
    assert.deepEqual(route.steps.map((s) => s.maneuver), ['straight', 'right', 'arrive']);
    assert.ok(Math.abs(route.steps[1].atM - 100) < 1, `${route.steps[1].atM}`);
    assert.ok(Math.abs((route.startBearingDeg ?? -1) - 0) < 1);
    assert.equal(turnCount(route), 1);
    assert.equal(route.startStreet, null);
    const named = buildRoute(
      { ...lRoute(), steps: [{ ...lRoute().steps[0], instructions: 'Start on A St' }, { ...lRoute().steps[1], instructions: 'Turn right onto B Ave' }, ...lRoute().steps.slice(2)] },
      'X',
    );
    assert.equal(named.startStreet, 'B Ave');
  });

  it('reads MapKit instructions into maneuvers', () => {
    assert.equal(maneuverOf('Take a left onto Sejong-daero'), 'left');
    assert.equal(maneuverOf('Take a right'), 'right');
    assert.equal(maneuverOf('Keep left at the fork'), 'slight-left');
    assert.equal(maneuverOf('Make a sharp right'), 'sharp-right');
    assert.equal(maneuverOf('Make a U-turn'), 'u-turn');
    assert.equal(maneuverOf('Continue onto Gwanghwamun Square'), 'straight');
    assert.equal(maneuverOf('The destination is on your left'), 'arrive');
  });
});

describe('route tracker', () => {
  it('prepares about 30 m before a turn, says it at the turn, and arrives, each once', () => {
    const { events } = walk(alongL());
    assert.deepEqual(events.map((e) => e.type), ['prepare', 'step', 'arrived']);
    const prepare = events[0] as Extract<TrackerEvent, { type: 'prepare' }>;
    assert.equal(prepare.step, 1);
    assert.ok(prepare.inM <= TRACKER.prepareM && prepare.inM > TRACKER.atStepM, `${prepare.inM}`);
    // The turn is said within 10 m of the corner (100 m along), the arrival within 15 m of the end.
    assert.ok(events[1].at >= 18 && events[1].at <= 20, `${events[1].at}`);
    assert.ok(events[2].at >= 37, `${events[2].at}`);
  });

  it('gives no instruction while the GPS is too inaccurate, and says so at most every 30 s', () => {
    const { events, state } = walk(alongL().slice(0, 30), 35);
    assert.deepEqual(events.map((e) => e.type), ['weak-gps']);
    assert.equal(state.gpsWeak, true);
    assert.equal(state.progressM, null);
  });

  it('reports leaving the route only after the grace period and 10 s more than 25 m away', () => {
    // On the route for 20 s, then 45 m east of it (5 m accuracy: 40 m beyond the GPS error).
    const away = [...Array.from({ length: 20 }, (_, i) => offset(i, 0)), ...Array.from({ length: 12 }, (_, i) => offset(20, 45 + i))];
    const { events } = walk(away);
    const off = events.filter((e) => e.type === 'off-route');
    assert.equal(off.length, 1);
    assert.ok(off[0].at >= 20 + 10, `${off[0].at}`);
  });

  it('does not call a wide street\'s far sidewalk "off the route"', () => {
    // 28 m from the line at 11 m accuracy, for a whole minute: within the GPS's own error.
    const sidewalk = Array.from({ length: 60 }, (_, i) => offset(Math.min(i, 90), 28));
    const { events } = walk(sidewalk, 11);
    assert.equal(events.filter((e) => e.type === 'off-route').length, 0);
  });

  it('gives a new route time before judging it', () => {
    // 40 m off from the very first position (the route starts across a street).
    const { events } = walk(Array.from({ length: 19 }, () => offset(0, 40)));
    assert.equal(events.filter((e) => e.type === 'off-route').length, 0);
  });

  it('never says a turn late after a GPS jump past it', () => {
    const jump = [offset(0, 0), offset(40, 0), offset(100, 40), offset(100, 45)];
    const { events } = walk(jump);
    assert.equal(events.filter((e) => e.type === 'step' || e.type === 'prepare').length, 0);
  });

  it('mentions a turn that comes soon after another with it', () => {
    const route = buildRoute(
      {
        distance: 130,
        steps: [
          { instructions: 'Turn right', notice: '', distance: 100, points: [[offset(0, 0).lat, offset(0, 0).lon], [offset(100, 0).lat, offset(100, 0).lon]] },
          { instructions: 'Turn left', notice: '', distance: 30, points: [[offset(100, 0).lat, offset(100, 0).lon], [offset(100, 30).lat, offset(100, 30).lon]] },
          { instructions: 'Turn right', notice: '', distance: 50, points: [[offset(100, 30).lat, offset(100, 30).lon], [offset(150, 30).lat, offset(150, 30).lon]] },
        ],
      },
      'X',
    );
    let state = startTracker(route);
    const said: TrackerEvent[] = [];
    [0, 50, 75, 92, 100].forEach((n, i) => {
      const out = track(route, state, { at: i * 1000, point: offset(n, 0), accuracyM: 5 });
      state = out.state;
      said.push(...out.events);
    });
    const step = said.find((e) => e.type === 'step' && e.step === 1) as Extract<TrackerEvent, { type: 'step' }>;
    assert.ok(step?.then && step.then.step === 2, JSON.stringify(said));
    assert.ok(state.prepared.includes(2));
  });

  it('leaves the start of the route to the start line', () => {
    const route = buildRoute(lRoute(), 'Test Cafe');
    assert.deepEqual(startTracker(route).done, [0]);
    assert.deepEqual(firstStep(route), { step: 1, inM: route.steps[1].atM });
    assert.equal(INITIAL_TRACKER.done.length, 0);
  });

  it('knows the next step and what is left for "what\'s next"', () => {
    const { route, state } = walk(alongL().slice(0, 9)); // 40 m north
    const next = nextStep(route, state);
    assert.equal(next?.step, 1);
    assert.ok(next?.inM != null && Math.abs(next.inM - 60) < 2);
    assert.ok(Math.abs((remainingM(route, state) ?? 0) - 160) < 2);
  });
});

describe('route phrases', () => {
  it('rounds distances and always says "about"', () => {
    assert.equal(aboutDistance(4), 'a few meters');
    assert.equal(aboutDistance(43), 'about 40 meters');
    assert.equal(aboutDistance(456), 'about 460 meters');
    assert.equal(aboutDistance(1234), 'about 1.2 kilometers');
    assert.equal(aboutDistance(2000), 'about 2 kilometers');
  });

  it('never repeats a MapKit instruction that would command HeyNavi', () => {
    const step = (instruction: string) => ({ instruction, maneuver: maneuverOf(instruction), atM: 10, notice: '' });
    assert.equal(instructionText(step('Turn right onto Sejong-daero.')), 'Turn right onto Sejong-daero');
    assert.equal(instructionText(step('Stop')), 'Continue straight');
    assert.equal(instructionText(step('Turn left onto Navi-ro')), 'Turn left');
  });

  it('says where the route starts relative to the phone, or by the compass', () => {
    assert.equal(startDirection(90, 80), 'The route starts ahead of you.');
    assert.equal(startDirection(90, 0), 'The route starts to your right.');
    assert.equal(startDirection(0, 90), 'The route starts to your left.');
    assert.equal(startDirection(180, 0), 'The route starts behind you.');
    assert.equal(startDirection(44, null), 'Head northeast.');
    assert.equal(startDirection(90, 0, 'Test-ro'), 'The route starts to your right, on Test-ro.');
    assert.equal(startDirection(0, null, 'Test-ro'), 'Head north on Test-ro.');
    assert.equal(startDirection(0, null, 'Stop'), 'Head north.');
  });

  it('voice audit: no route line commands HeyNavi, has the wake word, or calls a way safe', () => {
    const route = buildRoute(lRoute(), 'Test Cafe');
    const [straight, right] = route.steps;
    const lines = [
      routePhrases.unavailable(),
      routePhrases.locationDenied(),
      routePhrases.locating(),
      routePhrases.noLocation(),
      routePhrases.searching('Starbucks'),
      routePhrases.notFound('Starbucks'),
      routePhrases.noRoute('Starbucks'),
      routePhrases.failed(),
      routePhrases.start('Starbucks', 456, 3, startDirection(90, 0), { step: right, inM: 20 }),
      routePhrases.start('Starbucks', 80, 0, null, null),
      routePhrases.prepare(right, 30),
      routePhrases.step(right, null),
      routePhrases.step(straight, { step: right, inM: 30 }),
      routePhrases.next(right, 60, 'Starbucks', 160),
      routePhrases.next(null, null, 'Starbucks', null),
      routePhrases.weakGps(),
      routePhrases.offRoute(),
      routePhrases.rerouted(300),
      routePhrases.arrived('Starbucks'),
      routePhrases.ended(),
      routePhrases.notNavigating(),
      routePhrases.whereAmI({ street: 'Sejong-daero', area: 'Jongno-gu' }, { place: 'Starbucks', leftM: 300 }),
      routePhrases.whereAmI({}, null),
    ];
    for (const line of lines) {
      assert.equal(parse(line), null, line);
      for (const clause of line.split(/[.,:]\s*/).filter(Boolean)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
      assert.equal(analyze(line).wake, false, line);
      assert.doesNotMatch(line, /\b(safe|safely|clear)\b/i, line);
    }
  });

  it('voice audit: no route card string is a command or has the wake word', () => {
    const ui = routePhrases.ui;
    const strings = [
      ui.locating, ui.searching('Starbucks'), ui.routing, ui.rerouting, ui.arrived('Starbucks'), ui.fromMap, ui.weakGps,
      ui.inAbout(40), ui.left(320, 'Starbucks'), ui.closeButton, ui.closeHint,
    ];
    for (const line of strings) {
      assert.doesNotMatch(line, /navi|navy/i, line);
      assert.doesNotMatch(line, /^stop/i, line);
      assert.equal(parse(line), null, line);
      for (const clause of line.split(/[.,:·…]\s*/).filter(Boolean)) assert.equal(parse(clause), null, `"${clause}" in "${line}"`);
    }
  });
});
