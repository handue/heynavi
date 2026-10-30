/** Scene understanding types (ARCHITECTURE 4). Pure TypeScript, so everything runs under `node --test`. */
import type { Position } from '../agent/types.ts';

export type SceneKind = 'object' | 'possible_obstacle' | 'person' | 'text' | 'landmark';
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
  importance: Importance;
  /** Concept for SAM to check it (M4), or null. */
  ground: string | null;
  /** Verbatim readable text, only for kind "text". */
  text: string | null;
};

export type SceneContextItem = {
  label: string;
  kind: SceneKind;
  position: Position;
  age_s: number;
  spoken: boolean;
};

export type SceneContext = { summary: string | null; items: SceneContextItem[] };
