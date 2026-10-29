/** Builders shared by the agent tests (imported only from *.test.ts files). */
import type { Detection, FrameResult, Goal, Lang, Position } from './types.ts';

export function positionOf(centerX: number): Position {
  return centerX < 1 / 3 ? 'left' : centerX > 2 / 3 ? 'right' : 'center';
}

/** A square-ish box centered at `centerX`, with `area` as the fraction of the frame. */
export function det(centerX: number, confidence: number | null, area = 0.1): Detection {
  const side = Math.sqrt(area);
  return {
    box: [centerX - side / 2, 0.5 - side / 2, centerX + side / 2, 0.5 + side / 2],
    confidence,
    center_x: centerX,
    area,
    position: positionOf(centerX),
  };
}

export function goal(id = 'g1', concept = 'chair', lang: Lang = 'en-US'): Goal {
  return { id, concept, label: concept, lang };
}

export function frame(goalId: string, frameId: number, detections: Detection[], receivedAt = 0): FrameResult {
  return { goalId, frameId, detections, receivedAt };
}
