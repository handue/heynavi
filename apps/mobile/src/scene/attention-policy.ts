/**
 * What deserves attention (ARCHITECTURE 4.4): turns one scene reply, folded into memory, into
 * at most one spoken line. Deterministic and pure; the model proposes, this decides.
 *
 * - Quiet by default: one line per reply at most, at least ATTENTION.minGapMs apart, and at most
 *   ATTENTION.maxPerMinute per minute.
 * - Only what is new to the user: an item is spoken when it recently appeared (or Spark calls it
 *   new) and was not spoken within its dedupe window.
 * - Verbosity: quiet = high importance only; normal = high and medium; detailed = everything.
 * - Wording: templates over validated labels; the model's summary only after unspeakableReason.
 *   No "possible obstacle" wording yet: that needs SAM confirmation (M4).
 */
import type { AnnounceEffect } from '../agent/types.ts';
import type { MemoryItem, MergeResult } from './scene-memory.ts';
import { scenePhrases } from './scene-phrases.ts';
import type { Importance, SceneChange, SceneKind, Verbosity } from './types.ts';
import { unspeakableReason } from './wording.ts';

export const ATTENTION = {
  minGapMs: 6000,
  maxPerMinute: 6,
  /** An item that appeared this recently and was never spoken may still be mentioned. */
  recentMs: 12_000,
  dedupeMs: { item: 60_000, text: 120_000, low: 120_000, summary: 20_000 },
  /** Camera lines go stale fast: the scene moves on. */
  ttlMs: { camera: 4000, firstLook: 6000, reply: 8000 },
  describeMaxItems: 3,
} as const;

export type PolicyState = {
  firstLookDone: boolean;
  /** When proactive lines (and describe replies) were spoken, newest last, last minute only. */
  spokenAt: readonly number[];
  summarySpokenAt: number | null;
};

export const INITIAL_POLICY: PolicyState = { firstLookDone: false, spokenAt: [], summarySpokenAt: null };

export type DecisionNote =
  | 'first-look'
  | 'summary'
  | 'item'
  | 'describe'
  | 'nothing-new'
  | 'gap'
  | 'rate'
  | 'unspeakable';

export type Decision = {
  announcement: Omit<AnnounceEffect, 'type'> | null;
  /** Memory keys the line covers; mark them spoken when it is queued. */
  spokenKeys: string[];
  state: PolicyState;
  note: DecisionNote;
};

export type DecideInput = {
  reply: { summary: string | null; change: SceneChange };
  merged: MergeResult;
  verbosity: Verbosity;
  state: PolicyState;
  now: number;
  /** The user asked "what's around me": a priority-0 reply about everything in view. */
  describe?: boolean;
};

const IMPORTANCE_RANK: Record<Importance, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<SceneKind, number> = { possible_obstacle: 0, landmark: 1, person: 1, text: 2, object: 3 };

export function dedupeMsFor(item: Pick<MemoryItem, 'kind' | 'importance'>): number {
  if (item.kind === 'text') return ATTENTION.dedupeMs.text;
  if (item.importance === 'low') return ATTENTION.dedupeMs.low;
  return ATTENTION.dedupeMs.item;
}

/** Most important first: importance, then kind, then lower band, then center. */
export function rank(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort(
    (a, b) =>
      IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      Number(b.band === 'lower') - Number(a.band === 'lower') ||
      Number(b.position === 'center') - Number(a.position === 'center'),
  );
}

function allowedAt(verbosity: Verbosity, item: MemoryItem): boolean {
  if (verbosity === 'detailed') return true;
  if (verbosity === 'quiet') return item.importance === 'high';
  return item.importance !== 'low';
}

/** The spoken sentence for one item, or null when it would break the wording rules. */
export function itemLine(item: MemoryItem): string | null {
  if (item.kind === 'text') {
    if (item.text) {
      const withText = scenePhrases.text(item, item.text);
      if (unspeakableReason(withText) == null) return withText;
    }
    const plain = scenePhrases.textUnreadable(item);
    return unspeakableReason(plain) == null ? plain : null;
  }
  const line = scenePhrases.item(item);
  return unspeakableReason(line) == null ? line : null;
}

/** The model's summary as a spoken sentence, or null when it fails the filters. */
export function summaryLine(summary: string | null): string | null {
  if (!summary) return null;
  const line = scenePhrases.summary(summary);
  return unspeakableReason(line) == null ? line : null;
}

/** Items whose label the summary already names ("A hallway with a door" names "door"). */
function mentionedIn(summary: string, items: readonly MemoryItem[]): MemoryItem[] {
  const text = summary.toLowerCase();
  return items.filter((i) => new RegExp(`\\b${i.label.replace(/[^a-z ]/g, '')}s?\\b`).test(text));
}

function cameraLine(key: string, text: string, priority: 0 | 1 | 2 | 3, dedupeMs: number, ttlMs: number) {
  return { key, priority, text, lang: 'en-US' as const, ttlMs, dedupeMs, goalId: null, channel: 'camera' as const };
}

function recordSpoken(state: PolicyState, now: number): PolicyState['spokenAt'] {
  return [...state.spokenAt.filter((t) => now - t < 60_000), now];
}

export function decide(input: DecideInput): Decision {
  const { reply, merged, verbosity, state, now } = input;
  const reported = rank(merged.reported);
  const summary = summaryLine(reply.summary);

  if (input.describe) {
    const named = summary ? mentionedIn(summary, reported) : [];
    const extras = reported
      .filter((i) => !named.includes(i))
      .flatMap((i) => (itemLine(i) == null ? [] : [i]))
      .slice(0, ATTENTION.describeMaxItems);
    const parts = [summary, extras.length > 0 ? scenePhrases.items(extras) : null].filter(Boolean);
    const text = parts.length > 0 ? parts.join(' ') : scenePhrases.nothingNotable();
    const safe = unspeakableReason(text) == null ? text : scenePhrases.nothingNotable();
    return {
      announcement: {
        key: 'reply:describe',
        priority: 0,
        text: safe,
        lang: 'en-US',
        ttlMs: ATTENTION.ttlMs.reply,
        dedupeMs: 0,
        goalId: null,
        channel: 'reply',
      },
      spokenKeys: safe === text ? [...named, ...extras].map((i) => i.key) : [],
      state: {
        firstLookDone: true,
        spokenAt: recordSpoken(state, now),
        summarySpokenAt: summary && safe === text ? now : state.summarySpokenAt,
      },
      note: 'describe',
    };
  }

  if (!state.firstLookDone) {
    const shown = summary ? [] : reported.filter((i) => itemLine(i) != null).slice(0, 2);
    const text = summary ?? (shown.length > 0 ? scenePhrases.items(shown) : null);
    const next: PolicyState = { ...state, firstLookDone: true };
    if (!text || unspeakableReason(text) != null) {
      return { announcement: null, spokenKeys: [], state: next, note: text ? 'unspeakable' : 'nothing-new' };
    }
    const keys = (summary ? mentionedIn(summary, reported) : shown).map((i) => i.key);
    return {
      announcement: cameraLine('scene:first-look', text, 2, 0, ATTENTION.ttlMs.firstLook),
      spokenKeys: keys,
      state: { ...next, spokenAt: recordSpoken(state, now), summarySpokenAt: summary ? now : state.summarySpokenAt },
      note: 'first-look',
    };
  }

  const freshKeys = new Set(merged.fresh.map((i) => i.key));
  const unspoken = (i: MemoryItem) => i.lastSpokenAt == null || now - i.lastSpokenAt > dedupeMsFor(i);
  const eligible = reported.filter(
    (i) =>
      allowedAt(verbosity, i) &&
      unspoken(i) &&
      (freshKeys.has(i.key) ||
        i.status === 'new' ||
        (i.lastSpokenAt == null && (now - i.firstSeenAt <= ATTENTION.recentMs || i.importance === 'high'))),
  );
  const wantSummary =
    reply.change === 'major' &&
    verbosity !== 'quiet' &&
    summary != null &&
    (state.summarySpokenAt == null || now - state.summarySpokenAt > ATTENTION.dedupeMs.summary);
  if (eligible.length === 0 && !wantSummary) {
    return { announcement: null, spokenKeys: [], state, note: 'nothing-new' };
  }

  const recent = state.spokenAt.filter((t) => now - t < 60_000);
  const last = recent[recent.length - 1];
  if (last != null && now - last < ATTENTION.minGapMs) return { announcement: null, spokenKeys: [], state, note: 'gap' };
  if (recent.length >= ATTENTION.maxPerMinute) return { announcement: null, spokenKeys: [], state, note: 'rate' };

  if (wantSummary && summary) {
    const named = mentionedIn(summary, reported);
    // An important item the summary leaves out is said right after it, in the same line.
    const top = eligible.find((i) => i.importance === 'high' && !named.includes(i));
    const topLine = top ? itemLine(top) : null;
    const text = topLine ? `${summary} ${topLine}` : summary;
    return {
      announcement: cameraLine('scene:summary', text, 2, ATTENTION.dedupeMs.summary, ATTENTION.ttlMs.camera),
      spokenKeys: [...named, ...(topLine && top ? [top] : [])].map((i) => i.key),
      state: { ...state, spokenAt: recordSpoken(state, now), summarySpokenAt: now },
      note: 'summary',
    };
  }

  for (const item of eligible) {
    const line = itemLine(item);
    if (!line) continue;
    const priority = item.kind === 'text' || item.importance === 'low' ? 3 : 2;
    return {
      announcement: cameraLine(`scene:item:${item.key}`, line, priority, dedupeMsFor(item), ATTENTION.ttlMs.camera),
      spokenKeys: [item.key],
      state: { ...state, spokenAt: recordSpoken(state, now) },
      note: 'item',
    };
  }
  return { announcement: null, spokenKeys: [], state, note: 'unspeakable' };
}
