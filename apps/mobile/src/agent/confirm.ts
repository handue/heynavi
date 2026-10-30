/**
 * Multi-frame confirmation (ARCHITECTURE 5.1). Per-image SAM calls have no stable object ids,
 * so detections in different frames count as the same object when their centers are close.
 */
import type { Detection } from './types.ts';

export const CONFIRM = {
  /** Minimum confidence for a candidate. */
  tauDetect: 0.4,
  /** Confidence each agreeing frame must reach. */
  tauConfirm: 0.5,
  /** Frames considered, newest last. */
  windowSize: 3,
  /** Frames out of the window that must agree. */
  required: 2,
  /** Agreeing centers lie within this fraction of the frame width (max - min). */
  maxCenterSpread: 0.25,
} as const;

export type ConfirmParams = {
  tauDetect: number;
  tauConfirm: number;
  windowSize: number;
  required: number;
  maxCenterSpread: number;
};

/** Null confidence never passes a threshold. */
export function meets(detection: Detection, tau: number): boolean {
  return detection.confidence != null && detection.confidence >= tau;
}

/** Detections at or above `tau`, sorted by confidence (highest first). */
export function candidates(detections: readonly Detection[], tau: number = CONFIRM.tauDetect): Detection[] {
  return detections
    .filter((d) => meets(d, tau))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

export function bestCandidate(
  detections: readonly Detection[],
  tau: number = CONFIRM.tauDetect,
): Detection | null {
  return candidates(detections, tau)[0] ?? null;
}

export type Confirmation = {
  /** The agreeing detection from the newest frame of the agreeing group. */
  detection: Detection;
  /** Indices (into the window) of the frames that agree. */
  frames: number[];
};

/**
 * Confirmed when at least `required` of the last `windowSize` frames each hold a detection with
 * confidence >= tauConfirm, all of whose centers lie within `maxCenterSpread` of each other.
 * Sliding window over the strong detections sorted by center_x: O(n^2) on a handful of boxes.
 */
export function confirm(
  window: readonly (readonly Detection[])[],
  params: ConfirmParams = CONFIRM,
): Confirmation | null {
  const recent = window.slice(-params.windowSize);
  const offset = window.length - recent.length;
  const strong = recent
    .flatMap((detections, frame) =>
      detections.filter((d) => meets(d, params.tauConfirm)).map((d) => ({ d, frame: frame + offset })),
    )
    .sort((a, b) => a.d.center_x - b.d.center_x);

  let best: Confirmation | null = null;
  for (let i = 0; i < strong.length; i++) {
    // Newest member per frame within [center_x, center_x + spread].
    const perFrame = new Map<number, Detection>();
    for (let j = i; j < strong.length; j++) {
      if (strong[j].d.center_x - strong[i].d.center_x > params.maxCenterSpread + 1e-9) break;
      const kept = perFrame.get(strong[j].frame);
      if (!kept || (strong[j].d.confidence ?? 0) > (kept.confidence ?? 0)) {
        perFrame.set(strong[j].frame, strong[j].d);
      }
    }
    if (perFrame.size < params.required) continue;
    const frames = [...perFrame.keys()].sort((a, b) => a - b);
    const newest = frames[frames.length - 1];
    const candidate: Confirmation = { detection: perFrame.get(newest)!, frames };
    // Prefer the group that reaches the newest frame, then the more confident detection.
    if (
      !best ||
      newest > best.frames[best.frames.length - 1] ||
      (newest === best.frames[best.frames.length - 1] &&
        (candidate.detection.confidence ?? 0) > (best.detection.confidence ?? 0))
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Candidate nearest to `trackX` (ties: higher confidence); the best candidate without a track. */
export function nearestCandidate(
  detections: readonly Detection[],
  trackX: number | null,
  tau: number = CONFIRM.tauDetect,
): Detection | null {
  const found = candidates(detections, tau);
  if (trackX == null) return found[0] ?? null;
  let nearest: Detection | null = null;
  for (const d of found) {
    if (!nearest || Math.abs(d.center_x - trackX) < Math.abs(nearest.center_x - trackX)) nearest = d;
  }
  return nearest;
}

/** Largest box by area (ties: higher confidence). */
export function largest(detections: readonly Detection[]): Detection | null {
  let biggest: Detection | null = null;
  for (const d of detections) {
    if (
      !biggest ||
      d.area > biggest.area ||
      (d.area === biggest.area && (d.confidence ?? 0) > (biggest.confidence ?? 0))
    ) {
      biggest = d;
    }
  }
  return biggest;
}
