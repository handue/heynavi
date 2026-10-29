/** POST /v1/detect wire types and response parsing. Pure, so it runs under `node --test`. */
import type { Detection, Position } from '../agent/types.ts';

export type DetectRequest = {
  /** Base64 JPEG bytes, no "data:" prefix. */
  image_b64: string;
  /** English noun phrase, e.g. "chair". */
  concept: string;
  goal_id: string;
  frame_id: number;
};

export type DetectResponse = {
  goal_id: string;
  frame_id: number;
  concept: string;
  /** SAM's image size; null when there were no detections. */
  image: { width: number; height: number } | null;
  /** Sorted by confidence, highest first (null last). */
  detections: Detection[];
  /** Null when the backend did not send usable timings. */
  timings_ms: { sam: number; parse: number; total: number } | null;
};

export type ApiError =
  | { kind: 'network'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'aborted'; message: string }
  | { kind: 'http'; status: number; code: string; message: string; retryAfterMs?: number }
  | { kind: 'bad_response'; status: number; message: string };

export type DetectResult =
  | { ok: true; data: DetectResponse; rttMs: number }
  | { ok: false; error: ApiError };

const POSITIONS: ReadonlySet<string> = new Set<Position>(['left', 'center', 'right']);

/** Codes for error responses without a contract body (e.g. a proxy in between). */
const STATUS_CODES: Record<number, string> = {
  401: 'unauthorized',
  413: 'image_too_large',
  422: 'invalid_request',
  429: 'rate_limited',
  504: 'timeout',
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One contract detection, or null when any field is missing or mistyped. */
export function parseDetection(value: unknown): Detection | null {
  if (!isObject(value)) return null;
  const { box, confidence, center_x, area, position } = value;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isNumber)) return null;
  if (!(confidence === null || isNumber(confidence))) return null;
  if (!isNumber(center_x) || !isNumber(area)) return null;
  if (typeof position !== 'string' || !POSITIONS.has(position)) return null;
  return {
    box: [box[0], box[1], box[2], box[3]],
    confidence,
    center_x,
    area,
    position: position as Position,
  };
}

/**
 * A 200 body, or null when it is not a detect response. Malformed detections are skipped
 * rather than failing the whole frame.
 */
export function parseDetectResponse(body: unknown): DetectResponse | null {
  if (!isObject(body)) return null;
  const { goal_id, frame_id, concept, image, detections, timings_ms } = body;
  if (typeof goal_id !== 'string' || typeof concept !== 'string') return null;
  if (!Number.isInteger(frame_id) || !Array.isArray(detections)) return null;

  let parsedImage: DetectResponse['image'] = null;
  if (isObject(image) && isNumber(image.width) && isNumber(image.height)) {
    parsedImage = { width: image.width, height: image.height };
  } else if (image != null) {
    return null;
  }

  const timings =
    isObject(timings_ms) &&
    isNumber(timings_ms.sam) &&
    isNumber(timings_ms.parse) &&
    isNumber(timings_ms.total)
      ? { sam: timings_ms.sam, parse: timings_ms.parse, total: timings_ms.total }
      : null;

  return {
    goal_id,
    frame_id: frame_id as number,
    concept,
    image: parsedImage,
    detections: detections.map(parseDetection).filter((d): d is Detection => d != null),
    timings_ms: timings,
  };
}

/**
 * A Retry-After header (delta-seconds or an HTTP date) in ms from `nowEpochMs`; null when absent
 * or unreadable.
 */
export function parseRetryAfter(value: string | null, nowEpochMs: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP dates start with a day name; Date.parse alone would also take "-5" as a year.
  const at = /^[A-Za-z]/.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(at) ? null : Math.max(0, at - nowEpochMs);
}

/** `{ "error": { "code", "message" } }`, falling back to a code derived from the status. */
export function parseErrorBody(status: number, body: unknown): { code: string; message: string } {
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  const fallback = STATUS_CODES[status] ?? (status >= 500 ? 'upstream_error' : 'http_error');
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : fallback,
    message: typeof error?.message === 'string' ? error.message : `HTTP ${status}`,
  };
}
