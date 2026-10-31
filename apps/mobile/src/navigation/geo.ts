/** Small geodesy for walking routes (a few kilometers): pure, unit-tested. */

export type LatLon = { lat: number; lon: number };

const EARTH_M = 6_371_000;
const RAD = Math.PI / 180;

/** Great-circle distance in meters. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north, in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** `b - a` as a signed angle in (-180, 180]: positive is clockwise (to the right). */
export function turnDeg(fromDeg: number, toDeg: number): number {
  const d = (((toDeg - fromDeg) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Meters east (x) and north (y) of `origin`. Accurate to well under a meter within a few km. */
export function toXY(origin: LatLon, p: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - origin.lon) * RAD * EARTH_M * Math.cos(origin.lat * RAD),
    y: (p.lat - origin.lat) * RAD * EARTH_M,
  };
}

/** Cumulative distance along a line at each of its points. */
export function cumulativeM(points: readonly LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distanceM(points[i - 1], points[i]));
  return out;
}

export type Snap = {
  /** Distance along the line to the closest point. */
  alongM: number;
  /** Distance from `p` to the line. */
  offM: number;
};

/**
 * The closest point of a line to `p`, considering only segments that overlap [fromM, toM] along
 * the line (so a route that doubles back is not matched to the wrong leg).
 */
export function snapToLine(
  points: readonly LatLon[],
  cumulative: readonly number[],
  p: LatLon,
  fromM = 0,
  toM = Number.POSITIVE_INFINITY,
): Snap | null {
  let best: Snap | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    if (cumulative[i + 1] < fromM || cumulative[i] > toM) continue;
    const a = toXY(p, points[i]);
    const b = toXY(p, points[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // p is the origin: the closest point of segment ab to (0, 0).
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / len2));
    const offM = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (!best || offM < best.offM) best = { alongM: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]), offM };
  }
  return best;
}

/** The point at `alongM` along the line. */
export function pointAt(points: readonly LatLon[], cumulative: readonly number[], alongM: number): LatLon {
  if (points.length === 1 || alongM <= 0) return points[0];
  for (let i = 0; i + 1 < points.length; i++) {
    if (cumulative[i + 1] >= alongM) {
      const span = cumulative[i + 1] - cumulative[i];
      const t = span === 0 ? 0 : (alongM - cumulative[i]) / span;
      return { lat: points[i].lat + t * (points[i + 1].lat - points[i].lat), lon: points[i].lon + t * (points[i + 1].lon - points[i].lon) };
    }
  }
  return points[points.length - 1];
}
