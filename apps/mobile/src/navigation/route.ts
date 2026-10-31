import { bearingDeg, cumulativeM, pointAt, type LatLon } from './geo.ts';

/** What a step asks the walker to do, read from MapKit's English instruction. */
export type Maneuver = 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'u-turn' | 'straight' | 'arrive';

/** A maneuver, `atM` meters along the route, with MapKit's instruction for it. */
export type RouteStep = { instruction: string; maneuver: Maneuver; atM: number; notice: string };

export type Route = {
  destination: string;
  points: LatLon[];
  cumulative: number[];
  lengthM: number;
  /** Steps with an instruction, in order. MapKit's empty first step is left out. */
  steps: RouteStep[];
  /** Which way the route leaves its start, degrees from north (for "the route starts to your left"). */
  startBearingDeg: number | null;
  /** The street the route starts on, from MapKit's first instructions ("Turn right onto Main St"). */
  startStreet: string | null;
};

/** MapKit's route as the native module returns it. */
export type MapKitRoute = { distance: number; steps: { instructions: string; notice: string; distance: number; points: [number, number][] }[] };

/** Instructions this close to the start are covered by the start line. */
export const START_M = 10;

export function maneuverOf(instruction: string): Maneuver {
  const t = instruction.toLowerCase();
  if (/destination|arrive/.test(t)) return 'arrive';
  if (/u-?turn/.test(t)) return 'u-turn';
  const side = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null;
  if (!side) return 'straight';
  if (/slight|bear|keep/.test(t)) return `slight-${side}`;
  if (/sharp/.test(t)) return `sharp-${side}`;
  return side;
}

/**
 * One line through all of MapKit's steps, each instruction placed where its step starts (MapKit
 * gives the instruction for the start of the step: "Turn right onto Sejong-daero", then the
 * step's line). Repeated joint points are dropped.
 */
export function buildRoute(map: MapKitRoute, destination: string): Route {
  const points: LatLon[] = [];
  const startIndex: number[] = [];
  for (const step of map.steps) {
    startIndex.push(Math.max(0, points.length - 1));
    for (const [lat, lon] of step.points) {
      const last = points[points.length - 1];
      if (!last || last.lat !== lat || last.lon !== lon) points.push({ lat, lon });
    }
  }
  const cumulative = cumulativeM(points);
  const steps: RouteStep[] = [];
  map.steps.forEach((step, i) => {
    const instruction = step.instructions.trim();
    if (!instruction) return;
    steps.push({ instruction, maneuver: maneuverOf(instruction), atM: cumulative[startIndex[i]] ?? 0, notice: step.notice.trim() });
  });
  const lengthM = cumulative[cumulative.length - 1] ?? 0;
  // The first 15 m (or less) of the route say which way it leaves.
  const ahead = points.length > 1 ? pointAt(points, cumulative, Math.min(15, lengthM)) : null;
  // The last named street among the instructions at the very start ("Start on A St", then
  // "Turn right onto B Ave": the walk starts on B Ave).
  const startStreet =
    steps.filter((s) => s.atM <= START_M && s.maneuver !== 'arrive').map((s) => streetOf(s.instruction)).filter(Boolean).pop() ?? null;
  return {
    destination,
    points,
    cumulative,
    lengthM,
    steps,
    startBearingDeg: ahead && lengthM > 2 ? bearingDeg(points[0], ahead) : null,
    startStreet,
  };
}

/** The street in an instruction: "Turn right onto Sejong-daero" -> "Sejong-daero". */
export function streetOf(instruction: string): string | null {
  const match = /\b(?:onto|on)\s+(.+?)[.\s]*$/i.exec(instruction.trim());
  return match ? match[1] : null;
}

/** Turns the walker will be told about (not "continue", not the arrival). */
export function turnCount(route: Route): number {
  return route.steps.filter((s) => s.maneuver !== 'straight' && s.maneuver !== 'arrive' && s.atM > 1).length;
}
