/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LatLon } from './geo.ts';
import { createNavigationController, routeHint, type LocationPort, type MapsPort, type NavigationSnapshot, type RouteLine } from './navigation-controller.ts';
import type { MapKitRoute } from './route.ts';
import type { Fix } from './route-tracker.ts';

const ORIGIN: LatLon = { lat: 37.5663, lon: 126.9779 };
function offset(northM: number, eastM: number): LatLon {
  return { lat: ORIGIN.lat + northM / 111_195, lon: ORIGIN.lon + eastM / (111_195 * Math.cos((ORIGIN.lat * Math.PI) / 180)) };
}
const pair = (p: LatLon): [number, number] => [p.lat, p.lon];

/** 60 m north, turn right, 60 m east. */
const ROUTE: MapKitRoute = {
  distance: 120,
  steps: [
    { instructions: '', notice: '', distance: 0, points: [pair(offset(0, 0))] },
    { instructions: 'Head north', notice: '', distance: 60, points: [pair(offset(0, 0)), pair(offset(30, 0)), pair(offset(60, 0))] },
    { instructions: 'Turn right onto Test-ro', notice: '', distance: 60, points: [pair(offset(60, 0)), pair(offset(60, 30)), pair(offset(60, 60))] },
    { instructions: 'The destination is on your right', notice: '', distance: 0, points: [pair(offset(60, 60))] },
  ],
};

function harness(options: { permission?: boolean } = {}) {
  const lines: RouteLine[] = [];
  const logs: string[] = [];
  let clock = 0;
  let onFix: ((fix: Fix) => void) | null = null;
  let watching = 0;
  const location: LocationPort = {
    requestPermission: async () => options.permission ?? true,
    watch: async (fix) => {
      onFix = fix;
      watching++;
      return () => {
        onFix = null;
        watching--;
      };
    },
  };
  const searched: string[] = [];
  const maps: MapsPort = {
    searchPlaces: async (query) => {
      searched.push(query);
      return [
        { name: 'Far Cafe', latitude: offset(900, 0).lat, longitude: offset(900, 0).lon },
        { name: 'Near Cafe', latitude: offset(60, 60).lat, longitude: offset(60, 60).lon },
      ];
    },
    walkingRoute: async () => ROUTE,
    reverseGeocode: async () => ({ street: 'Test-ro', area: 'Jongno-gu' }),
  };
  const timers: (() => void)[] = [];
  const nav = createNavigationController({
    maps,
    location,
    say: (line) => lines.push(line),
    now: () => clock,
    log: (line) => logs.push(line),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function fix(point: LatLon, accuracyM = 5) {
    clock += 1000;
    onFix?.({ at: clock, point, accuracyM });
    await settle();
  }
  return { nav, lines, logs, fix, settle, searched, watchingCount: () => watching };
}

describe('navigation controller', () => {
  it('finds the nearest place, starts the route, and says each step to the arrival', async () => {
    const h = harness();
    const started = h.nav.start('cafe');
    await h.settle();
    assert.equal(h.nav.getSnapshot().status, 'locating');
    await h.fix(offset(0, 0), 8);
    await started;
    assert.equal(h.nav.getSnapshot().status, 'navigating');
    assert.equal(h.nav.getSnapshot().destination, 'Near Cafe');
    const start = h.lines.find((l) => l.key === 'route:start');
    assert.match(start?.text ?? '', /^Route to Near Cafe: about 120 meters, 1 turn\. Head north\. In about 60 meters, turn right onto Test-ro\.$/);

    for (let n = 5; n <= 60; n += 5) await h.fix(offset(n, 0));
    for (let e = 5; e <= 60; e += 5) await h.fix(offset(60, e));
    const said = h.lines.filter((l) => l.kind === 'route').map((l) => l.key.replace(/:\d+$/, ''));
    assert.deepEqual(said, ['route:start', 'route:prepare', 'route:step', 'route:arrived']);
    assert.match(h.lines.find((l) => l.key === 'route:step:1')?.text ?? '', /^Now, turn right onto Test-ro\.$/);
    assert.equal(h.nav.getSnapshot().status, 'arrived');
    assert.equal(h.watchingCount(), 0, 'location stops after the arrival');
  });

  it('never uploads coordinates or place names', async () => {
    const h = harness();
    const started = h.nav.start('cafe');
    await h.settle();
    await h.fix(offset(0, 0), 8);
    await started;
    for (let n = 5; n <= 60; n += 5) await h.fix(offset(n, 0));
    assert.ok(h.logs.length >= 3);
    for (const line of h.logs) {
      assert.doesNotMatch(line, /37\.5|126\.9|Cafe|cafe|Test-ro/, line);
    }
  });

  it('says why when location access is off, and watches nothing', async () => {
    const h = harness({ permission: false });
    await h.nav.start('cafe');
    assert.equal(h.lines[0].key, 'route:denied');
    assert.equal(h.nav.getSnapshot().status, 'idle');
    assert.equal(h.watchingCount(), 0);
  });

  it('answers "what\'s next" and "where am I" during a route', async () => {
    const h = harness();
    const started = h.nav.start('cafe');
    await h.settle();
    await h.fix(offset(0, 0), 8);
    await started;
    await h.fix(offset(20, 0));
    h.nav.whatsNext();
    assert.match(h.lines[h.lines.length - 1].text, /^Next: in about 40 meters, turn right onto Test-ro\. About 100 meters to Near Cafe\.$/);
    const where = h.nav.whereAmI();
    await h.fix(offset(21, 0));
    await where;
    assert.match(h.lines[h.lines.length - 1].text, /^You're on Test-ro in Jongno-gu, according to the map\. About 100 meters to Near Cafe\.$/);
  });

  it('ends a route on "stop navigation" and says when none is active', async () => {
    const h = harness();
    h.nav.stop();
    assert.equal(h.lines[0].key, 'route:not-navigating');
    const started = h.nav.start('cafe');
    await h.settle();
    await h.fix(offset(0, 0), 8);
    await started;
    h.nav.stop();
    assert.equal(h.lines[h.lines.length - 1].key, 'route:ended');
    assert.equal(h.nav.getSnapshot().status, 'idle');
    assert.equal(h.watchingCount(), 0);
  });

  it('tells the scene look only the kind of the next step and whether it is close', async () => {
    const h = harness();
    assert.equal(routeHint(h.nav.getSnapshot()), null, 'no route, no hint');
    const started = h.nav.start('cafe');
    await h.settle();
    await h.fix(offset(0, 0), 8);
    await started;
    await h.fix(offset(10, 0));
    assert.deepEqual(routeHint(h.nav.getSnapshot()), { next: 'right', soon: true });
    const hint = (next: NavigationSnapshot['next'], gpsWeak = false): ReturnType<typeof routeHint> =>
      routeHint({ status: 'navigating', destination: 'Near Cafe', next, leftM: 300, gpsWeak });
    assert.deepEqual(hint({ instruction: 'Turn left onto A St', maneuver: 'sharp-left', inM: 200 }), { next: 'left', soon: false });
    assert.deepEqual(hint({ instruction: 'Arrive', maneuver: 'arrive', inM: 20 }), { next: 'arrive', soon: true });
    assert.deepEqual(hint({ instruction: 'Bear right', maneuver: 'slight-right', inM: 20 }, true), { next: 'right', soon: false });
    assert.equal(JSON.stringify(routeHint(h.nav.getSnapshot())).match(/Cafe|Test-ro|\d{2}\./), null, 'no place, street or position');
  });

  it('re-routes after being off the route, at most once every 45 s', async () => {
    const h = harness();
    const started = h.nav.start('cafe');
    await h.settle();
    await h.fix(offset(0, 0), 8);
    await started;
    for (let n = 1; n <= 20; n++) await h.fix(offset(n, 0));
    // Then 50 m off the line for 80 s: the re-routed line (the same fake route) is still off.
    // First re-route ~10 s in; the next only after the new route's grace and the 45 s cooldown.
    for (let i = 0; i < 80; i++) await h.fix(offset(10, 50));
    const keys = h.lines.map((l) => l.key);
    assert.ok(keys.includes('route:off:1'), keys.join(' '));
    assert.ok(keys.includes('route:rerouted:1'), keys.join(' '));
    assert.equal(keys.filter((k) => k.startsWith('route:off:')).length, 2, keys.join(' '));
    assert.ok(h.logs.some((l) => l.includes('off-route-held')));
    assert.equal(h.nav.getSnapshot().status, 'navigating');
  });
});
