/** Agent core types. Pure TypeScript (no React, no Expo), so everything runs under `node --test`. */

export type Lang = 'en-US' | 'ko-KR';

/** Box-center horizontal third, relative to the camera view (never to the user's body). */
export type Position = 'left' | 'center' | 'right';

/** One SAM instance, exactly as POST /v1/detect returns it (wire names kept on purpose). */
export type Detection = {
  /** [x1, y1, x2, y2], normalized 0..1, top-left origin, exclusive x2/y2. */
  box: [number, number, number, number];
  /** Null when SAM gave no score. A null score never counts as a candidate. */
  confidence: number | null;
  center_x: number;
  /** Box area as a fraction of the frame. */
  area: number;
  position: Position;
};

/** One answered frame for one goal. `receivedAt` uses the session clock (ms). */
export type FrameResult = {
  goalId: string;
  frameId: number;
  detections: Detection[];
  receivedAt: number;
};

export type SearchStatus =
  | 'IDLE'
  | 'SEARCHING'
  | 'CONFIRMING'
  | 'FOUND'
  | 'GUIDING'
  | 'LOST'
  | 'PAUSED'
  | 'CANCELLED';

export type Goal = {
  /** New id per objective; results tagged with another id are dropped. */
  id: string;
  /** English noun phrase sent to SAM, e.g. "chair". */
  concept: string;
  /** What the user sees and hears, in `lang`, e.g. "의자". */
  label: string;
  lang: Lang;
};

export type SearchState = {
  status: SearchStatus;
  goal: Goal | null;
  /** Candidate detections of the last frames (at most CONFIRM.windowSize), oldest first. */
  window: Detection[][];
  /** Consecutive frames without a candidate (CONFIRMING and GUIDING). */
  misses: number;
  startedAt: number | null;
  /**
   * Last frame with a confirm-strength candidate (or a tracked match while guiding). Coaching and
   * the check-in count from here (or from start).
   */
  lastCandidateAt: number | null;
  nextCoachingAt: number | null;
  coachingCount: number;
  checkInDone: boolean;
  /** center_x of the object being guided to, so several instances do not swap. */
  trackX: number | null;
  /** Position bucket of the tracked object in the latest frame. */
  position: Position | null;
  /** Last position bucket that was spoken, and when. */
  spokenPosition: Position | null;
  spokenPositionAt: number | null;
  foundAt: number | null;
  /**
   * Bumped each time the user is told the target is out of view (lost, resume). It is part of the
   * found and lost dedupe keys, so a re-find after "I lost sight of it" is spoken again.
   */
  episode: number;
  /** Start of the current run of failed frames (no evidence); null while frames succeed. */
  outageSince: number | null;
};

/** 0 reply to the user, 1 goal event, 2 status, 3 ambient. Lower number wins. */
export type Priority = 0 | 1 | 2 | 3;

export type AnnounceEffect = {
  type: 'announce';
  /** Dedupe key, e.g. "found:<goal>:<episode>:left". */
  key: string;
  priority: Priority;
  text: string;
  lang: Lang;
  /** Dropped if it waits in the queue longer than this. */
  ttlMs: number;
  /** Not spoken again within this window after it was spoken (0 = no dedupe). */
  dedupeMs: number;
  /** Dropped if the goal changed before it is spoken; null = not tied to a goal. */
  goalId: string | null;
};

export type HapticKind = 'found' | 'centered';

export type Effect = AnnounceEffect | { type: 'haptic'; kind: HapticKind } | { type: 'none' };
