/** POST /v1/ask wire types and response parsing. Pure, so it runs under `node --test`. */
import type { Detection, Position } from '../agent/types.ts';
import type { Band, HoldFrame, SceneContext } from '../scene/types.ts';
import { parseDetection, type ApiError } from './detect-response.ts';

export type AskRequest = {
  /** Base64 JPEG bytes, no "data:" prefix. */
  image_b64: string;
  session_id: string;
  question: string;
  context: SceneContext;
  /** How the phone was held for this frame: the answer uses the same kind of directions. */
  hold: HoldFrame;
};

export type AskTarget = {
  label: string;
  ground: string | null;
  visible: boolean;
  position: Position;
  band: Band;
  grounded: boolean | null;
  detections: Detection[];
};

export type AskResponse = {
  /** Null when the model's answer broke the wording rules. */
  answer: string | null;
  about: AskTarget | null;
  /** The thing asked for is not in view: keep looking for `about.ground`. */
  search: boolean;
  timings_ms: { spark: number; sam: number | null; total: number } | null;
  cost_usd: number | null;
};

export type AskResult = { ok: true; data: AskResponse; rttMs: number } | { ok: false; error: ApiError };

const POSITIONS = new Set(['left', 'center', 'right']);
const BANDS = new Set(['lower', 'middle', 'upper']);
const LABEL_RE = /^[a-z][a-z -]{0,63}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseTarget(value: unknown): AskTarget | null {
  if (!isObject(value)) return null;
  const { label, ground, visible, position, band, grounded, detections } = value;
  if (typeof label !== 'string' || !LABEL_RE.test(label)) return null;
  if (typeof position !== 'string' || !POSITIONS.has(position) || typeof band !== 'string' || !BANDS.has(band)) return null;
  return {
    label,
    ground: typeof ground === 'string' && LABEL_RE.test(ground) ? ground : null,
    visible: visible === true,
    position: position as Position,
    band: band as Band,
    grounded: typeof grounded === 'boolean' ? grounded : null,
    detections: Array.isArray(detections) ? detections.map(parseDetection).filter((d): d is Detection => d != null) : [],
  };
}

/** A 200 body, or null when it is not an ask response. */
export function parseAskResponse(body: unknown): AskResponse | null {
  if (!isObject(body)) return null;
  const { answer, about, search, timings_ms, usage } = body;
  if (!(answer === null || typeof answer === 'string') || typeof search !== 'boolean') return null;
  const target = about == null ? null : parseTarget(about);
  return {
    answer: typeof answer === 'string' && answer.length > 0 ? answer : null,
    about: target,
    search: search && target != null && target.ground != null,
    timings_ms:
      isObject(timings_ms) && isNumber(timings_ms.spark) && isNumber(timings_ms.total)
        ? { spark: timings_ms.spark, sam: isNumber(timings_ms.sam) ? timings_ms.sam : null, total: timings_ms.total }
        : null,
    cost_usd: isObject(usage) && isNumber(usage.cost_usd) ? usage.cost_usd : null,
  };
}
