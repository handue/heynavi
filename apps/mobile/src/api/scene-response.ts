/** POST /v1/scene wire types and response parsing. Pure, so it runs under `node --test`. */
import type { Detection, Position } from '../agent/types.ts';
import type {
  Band,
  Importance,
  ItemStatus,
  SceneChange,
  SceneContext,
  SceneItem,
  SceneKind,
} from '../scene/types.ts';
import { parseDetection, type ApiError } from './detect-response.ts';

export type SceneRequest = {
  /** Base64 JPEG bytes, no "data:" prefix. */
  image_b64: string;
  session_id: string;
  frame_id: number;
  context: SceneContext;
  /** The user asked "what's around me". */
  detailed: boolean;
  /** How many of Spark's items SAM should locate and check on the same frame (0–4). */
  ground: number;
};

export type SceneResponse = {
  session_id: string;
  frame_id: number;
  summary: string | null;
  change: SceneChange;
  items: SceneItem[];
  /** Why the backend dropped sentences or labels (reasons only). */
  filtered: string[];
  timings_ms: { spark: number; parse: number; sam: number | null; total: number } | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    sam_images: number;
    cost_usd: number;
  } | null;
};

export type SceneResult = { ok: true; data: SceneResponse; rttMs: number } | { ok: false; error: ApiError };

const KINDS: ReadonlySet<string> = new Set<SceneKind>([
  'object',
  'possible_obstacle',
  'level_change',
  'overhead',
  'person',
  'text',
  'landmark',
]);
const POSITIONS: ReadonlySet<string> = new Set<Position>(['left', 'center', 'right']);
const BANDS: ReadonlySet<string> = new Set<Band>(['lower', 'middle', 'upper']);
const STATUSES: ReadonlySet<string> = new Set<ItemStatus>(['new', 'still', 'moved', 'gone']);
const IMPORTANCES: ReadonlySet<string> = new Set<Importance>(['high', 'medium', 'low']);
const CHANGES: ReadonlySet<string> = new Set<SceneChange>(['none', 'minor', 'major']);
/** Same shape the backend validates. */
const LABEL_RE = /^[a-z][a-z -]{0,63}$/;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const intOrNull = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const isIn = (set: ReadonlySet<string>, v: unknown): v is string => typeof v === 'string' && set.has(v);

export function parseSceneItem(value: unknown): SceneItem | null {
  if (!isObject(value)) return null;
  const { label, count, kind, position, band, status, importance, ground, text, grounded, detections } = value;
  if (typeof label !== 'string' || !LABEL_RE.test(label)) return null;
  if (!Number.isInteger(count) || (count as number) < 1) return null;
  if (!isIn(KINDS, kind) || !isIn(POSITIONS, position) || !isIn(BANDS, band)) return null;
  if (!isIn(STATUSES, status) || !isIn(IMPORTANCES, importance)) return null;
  const groundText = stringOrNull(ground);
  return {
    label,
    count: count as number,
    kind: kind as SceneKind,
    position: position as Position,
    band: band as Band,
    status: status as ItemStatus,
    importance: importance as Importance,
    ground: groundText && LABEL_RE.test(groundText) ? groundText : null,
    text: kind === 'text' ? stringOrNull(text) : null,
    grounded: typeof grounded === 'boolean' ? grounded : null,
    detections: Array.isArray(detections)
      ? detections.map(parseDetection).filter((d): d is Detection => d != null)
      : [],
  };
}

/** A 200 body, or null when it is not a scene response. Malformed items are skipped. */
export function parseSceneResponse(body: unknown): SceneResponse | null {
  if (!isObject(body)) return null;
  const { session_id, frame_id, summary, change, items, filtered, timings_ms, usage } = body;
  if (typeof session_id !== 'string' || !Number.isInteger(frame_id)) return null;
  if (!isIn(CHANGES, change) || !Array.isArray(items)) return null;
  if (!(summary === null || typeof summary === 'string')) return null;

  const timings =
    isObject(timings_ms) && isNumber(timings_ms.spark) && isNumber(timings_ms.parse) && isNumber(timings_ms.total)
      ? {
          spark: timings_ms.spark,
          parse: timings_ms.parse,
          sam: isNumber(timings_ms.sam) ? timings_ms.sam : null,
          total: timings_ms.total,
        }
      : null;
  const parsedUsage =
    isObject(usage) && isNumber(usage.cost_usd)
      ? {
          input_tokens: intOrNull(usage.input_tokens),
          output_tokens: intOrNull(usage.output_tokens),
          reasoning_tokens: intOrNull(usage.reasoning_tokens),
          sam_images: intOrNull(usage.sam_images) ?? 0,
          cost_usd: usage.cost_usd,
        }
      : null;

  return {
    session_id,
    frame_id: frame_id as number,
    summary: stringOrNull(summary),
    change: change as SceneChange,
    items: items.map(parseSceneItem).filter((i): i is SceneItem => i != null),
    filtered: Array.isArray(filtered) ? filtered.filter((f): f is string => typeof f === 'string') : [],
    timings_ms: timings,
    usage: parsedUsage,
  };
}
