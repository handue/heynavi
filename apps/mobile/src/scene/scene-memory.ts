/**
 * Short-term scene memory (ARCHITECTURE 4.3): what Spark reported over the last ~30 s and what
 * HeyNavi already said about it. It is what lets HeyNavi talk about changes instead of every
 * frame, and it becomes the compact context sent with the next frame. Pure and immutable.
 */
import type { Position } from '../agent/types.ts';
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
    const next: MemoryItem = {
      key,
      label: item.label,
      count: item.count,
      kind: item.kind,
      position: item.position,
      band: item.band,
      importance: item.importance,
      status: item.status,
      text: item.text ?? known?.text ?? null,
      ground: item.ground,
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
