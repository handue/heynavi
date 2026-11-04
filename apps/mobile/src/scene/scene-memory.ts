/**
 * Short-term scene memory (ARCHITECTURE 4.3): what Spark reported over the last ~30 s and what
 * HeyNavi already said about it. It is what lets HeyNavi talk about changes instead of every
 * frame, and it becomes the compact context sent with the next frame. Pure and immutable.
 */
import type { Detection, Position } from '../agent/types.ts';
import type {
  Band,
  Importance,
  ItemStatus,
  SceneContext,
  SceneItem,
  SceneKind,
} from './types.ts';

export const MEMORY = {
  /** An item not reported for this long is forgotten. */
  expireMs: 30_000,
  /** Items sent back to Spark as context, most recently seen first. */
  maxContextItems: 8,
  maxSummaries: 3,
} as const;

export type MemoryItem = {
  key: string;
  label: string;
  count: number;
  kind: SceneKind;
  position: Position;
  band: Band;
  importance: Importance;
  /** Spark's last status for it. */
  status: ItemStatus;
  text: string | null;
  ground: string | null;
  /**
   * SAM's latest verdict while in memory: true once found, false if it looked and did not find
   * it, null if never checked. A later unchecked reply keeps the earlier verdict.
   */
  grounded: boolean | null;
  /** SAM's best box on the latest frame that reported it, or null. */
  box: Detection | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** When HeyNavi last spoke about it; null if never. */
  lastSpokenAt: number | null;
};

export type SceneMemory = {
  items: readonly MemoryItem[];
  /** Newest last. */
  summaries: readonly { text: string; at: number }[];
};

export const EMPTY_MEMORY: SceneMemory = { items: [], summaries: [] };

/** One entry per label: Spark reports each kind of thing once, with a count. */
export function itemKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type MergeResult = {
  memory: SceneMemory;
  /** Items in this reply that were not in memory before it (new to HeyNavi). */
  fresh: readonly MemoryItem[];
  /** Every item this reply reported (fresh ones included), in the reply's order. */
  reported: readonly MemoryItem[];
};

/**
 * Folds one reply into memory. "gone" items are removed; items not mentioned are kept until
 * they expire, because Spark only lists what it can see in this frame.
 */
export function mergeReply(
  memory: SceneMemory,
  reply: { summary: string | null; items: readonly SceneItem[] },
  now: number,
): MergeResult {
  const byKey = new Map(expire(memory, now).items.map((i) => [i.key, i]));
  const fresh: MemoryItem[] = [];
  const reported: MemoryItem[] = [];
  for (const item of reply.items) {
    const key = itemKey(item.label);
    const known = byKey.get(key);
    if (item.status === 'gone') {
      byKey.delete(key);
      continue;
    }
    // SAM's box is more precise than Spark's thirds: when SAM found it, its box sets the position.
    const box = item.grounded ? pickBox(item.detections, item.position) : null;
    const next: MemoryItem = {
      key,
      label: item.label,
      count: item.count,
      kind: item.kind,
      position: box ? box.position : item.position,
      band: box ? bandOf(box) : item.band,
      importance: item.importance,
      status: item.status,
      text: item.text ?? known?.text ?? null,
      ground: item.ground,
      grounded: item.grounded ?? known?.grounded ?? null,
      box,
      firstSeenAt: known?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastSpokenAt: known?.lastSpokenAt ?? null,
    };
    byKey.set(key, next);
    reported.push(next);
    if (!known) fresh.push(next);
  }
  const summaries = reply.summary
    ? [...memory.summaries, { text: reply.summary, at: now }].slice(-MEMORY.maxSummaries)
    : memory.summaries;
  return { memory: { items: [...byKey.values()], summaries }, fresh, reported };
}

/**
 * The SAM box for the thing Spark meant: SAM returns every instance of the concept, and the most
 * confident one can be another door than the one Spark described. A confident box in Spark's
 * third wins; otherwise the most confident box.
 */
export function pickBox(detections: readonly Detection[], position: Position): Detection | null {
  return detections.find((d) => d.position === position && (d.confidence ?? 0) >= 0.5) ?? detections[0] ?? null;
}

/** Vertical third of a SAM box's center. */
export function bandOf(box: Pick<Detection, 'box'>): Band {
  const cy = (box.box[1] + box.box[3]) / 2;
  return cy > 2 / 3 ? 'lower' : cy < 1 / 3 ? 'upper' : 'middle';
}

export function expire(memory: SceneMemory, now: number): SceneMemory {
  const items = memory.items.filter((i) => now - i.lastSeenAt <= MEMORY.expireMs);
  return items.length === memory.items.length ? memory : { ...memory, items };
}

export function markSpoken(memory: SceneMemory, keys: readonly string[], now: number): SceneMemory {
  if (keys.length === 0) return memory;
  const spoken = new Set(keys);
  return {
    ...memory,
    items: memory.items.map((i) => (spoken.has(i.key) ? { ...i, lastSpokenAt: now } : i)),
  };
}

/** When each of `keys` was last spoken about before a line marks them (null: never). */
export function spokenBefore(memory: SceneMemory, keys: readonly string[]): Record<string, number | null> {
  const byKey = new Map(memory.items.map((i) => [i.key, i]));
  return Object.fromEntries(keys.map((k) => [k, byKey.get(k)?.lastSpokenAt ?? null]));
}

/**
 * Undoes markSpoken(…, at) for a line that was never heard: each item goes back to when it was
 * last spoken before (`previous`, from spokenBefore), unless a later line marked it since. Its
 * "recently appeared" window starts again `now`: Spark calls it "still" by the next reply, which
 * on cellular comes after that window, and a medium-relevance curb would never be said.
 */
export function unmarkSpoken(
  memory: SceneMemory,
  previous: Readonly<Record<string, number | null>>,
  at: number,
  now: number,
): SceneMemory {
  if (Object.keys(previous).length === 0) return memory;
  return {
    ...memory,
    items: memory.items.map((i) =>
      i.key in previous && i.lastSpokenAt === at ? { ...i, lastSpokenAt: previous[i.key], firstSeenAt: now } : i,
    ),
  };
}

/** The compact context for the next /v1/scene call. */
export function contextFor(memory: SceneMemory, now: number): SceneContext {
  const items = [...expire(memory, now).items]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MEMORY.maxContextItems)
    .map((i) => ({
      label: i.label,
      kind: i.kind,
      position: i.position,
      age_s: Math.max(0, Math.round((now - i.lastSeenAt) / 1000)),
      spoken: i.lastSpokenAt != null,
    }));
  const last = memory.summaries[memory.summaries.length - 1];
  return { summary: last ? last.text.slice(0, 300) : null, items };
}
