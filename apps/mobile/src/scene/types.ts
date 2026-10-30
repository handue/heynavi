/** Scene understanding types (ARCHITECTURE 4). Pure TypeScript, so everything runs under `node --test`. */
import type { Detection, Position } from '../agent/types.ts';

export type SceneKind =
  | 'object'
  | 'possible_obstacle'
  /** Stairs, steps, curbs, ramps, drop-offs. */
  | 'level_change'
  /** Low-hanging or protruding at head or body height. */
  | 'overhead'
  | 'person'
  | 'text'
  | 'landmark';
/** Vertical third of the camera view. */
export type Band = 'lower' | 'middle' | 'upper';
/** Spark's comparison with the context the app sent. */
export type ItemStatus = 'new' | 'still' | 'moved' | 'gone';
export type Importance = 'high' | 'medium' | 'low';
export type SceneChange = 'none' | 'minor' | 'major';
/** How much HeyNavi says on its own. */
export type Verbosity = 'quiet' | 'normal' | 'detailed';

export const VERBOSITY_STEPS: readonly Verbosity[] = ['quiet', 'normal', 'detailed'];

/** One item exactly as POST /v1/scene returns it (wire names kept on purpose). */
export type SceneItem = {
  /** Short singular English noun phrase, lowercase: "office chair". */
  label: string;
  count: number;
  kind: SceneKind;
  position: Position;
  band: Band;
  status: ItemStatus;
  /** Walking relevance: high = in or next to the area ahead, medium = off to the side, low = none. */
  importance: Importance;
  /** Concept for SAM to check it, or null. */
  ground: string | null;
  /** Verbatim readable text, only for kind "text". */
  text: string | null;
  /** SAM's check on the same frame: null = not checked, true = found (c >= 0.5), false = not found. */
  grounded: boolean | null;
  /** SAM's boxes for `ground` on that frame, best first. */
  detections: Detection[];
};

/**
 * How the phone was held when the frame was taken. "forward": upright and roughly level, so the
 * camera's left and right are the user's (ARCHITECTURE 6.3). Anything else, or no sensor, is
 * described relative to the camera view.
 */
export type HoldFrame = 'forward' | 'camera';

export type SceneContextItem = {
  label: string;
  kind: SceneKind;
  position: Position;
  age_s: number;
  spoken: boolean;
};

export type SceneContext = { summary: string | null; items: SceneContextItem[] };
