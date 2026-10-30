/**
 * What deserves attention (ARCHITECTURE 4.4): turns one scene reply, folded into memory, into
 * at most one spoken line. Deterministic and pure; Spark proposes, SAM confirms, this decides.
 *
 * - Walking relevance, not interest: only kinds that can matter to someone walking (possible
 *   obstacles, level changes, overhead things, people, doors) with Spark's relevance above "low".
 *   Plain objects (pictures, screens, things on desks) and signs are never proactive, except signs
 *   at "detailed".
 * - Confirmed or hedged: what SAM found on the same frame is said plainly, with its box. A SAM miss
 *   is not proof that nothing is there: a hazard Spark puts in the walking area is still said,
 *   hedged ("There may be …"), with no box.
 * - Hazards first: a confirmed possible obstacle in the walking area, a level change or an
 *   overhead thing is a priority-1 line, with a shorter gap.
 * - Quiet by default: one line per reply, with at most two things in it, at least
 *   ATTENTION.minGapMs apart, and at most ATTENTION.maxPerMinute per minute.
 * - Only what is new to the user: recently appeared (or new to Spark) and not spoken within its
 *   dedupe window.
 * - Verbosity: quiet = high importance only; normal = high and medium; detailed = everything.
 * - Wording: templates over validated labels, user-relative only when the phone was held
 *   forward (HoldFrame); the model's summary only after unspeakableReason.
 */
import type { AnnounceEffect } from '../agent/types.ts';
import type { MemoryItem, MergeResult } from './scene-memory.ts';
import { scenePhrases } from './scene-phrases.ts';
import type { HoldFrame, Importance, SceneChange, SceneKind, Verbosity } from './types.ts';
import { unspeakableReason } from './wording.ts';

export const ATTENTION = {
  minGapMs: 6000,
  /** A confirmed possible obstacle may follow the previous line sooner. */
  obstacleGapMs: 3000,
  /** A second thing joins a line only while the line stays this short. */
  maxLineWords: 24,
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
  /**
   * When each item was last spoken about, kept for HISTORY_MS. Memory forgets an item after 30 s
   * unseen, but its dedupe window is 60–120 s: without this, a box seen again after 35 s was
   * "new" again (round 4).
   */
  spokenKeys: Readonly<Record<string, number>>;
};

export const INITIAL_POLICY: PolicyState = { firstLookDone: false, spokenAt: [], summarySpokenAt: null, spokenKeys: {} };

/** Longest dedupe window: a spoken key is remembered this long. */
const HISTORY_MS = 120_000;

function remember(state: PolicyState, keys: readonly string[], now: number): PolicyState['spokenKeys'] {
  const kept = Object.entries(state.spokenKeys).filter(([, at]) => now - at < HISTORY_MS);
  return Object.fromEntries([...kept, ...keys.map((k) => [k, now] as const)]);
}

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
  /** How the phone was held when the frame was taken; sets the wording of directions. */
  frame?: HoldFrame;
};

const IMPORTANCE_RANK: Record<Importance, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<SceneKind, number> = {
  possible_obstacle: 0,
  level_change: 0,
  overhead: 0,
  person: 1,
  landmark: 2,
  text: 3,
  object: 4,
};

/** Kinds that can matter to someone walking; "object" and "text" cannot get in the way. */
const WALKING_KINDS: ReadonlySet<SceneKind> = new Set(['possible_obstacle', 'level_change', 'overhead', 'person', 'landmark']);
/** Kinds worth a hedged line when SAM could not localize them. */
const UNCERTAIN_KINDS: ReadonlySet<SceneKind> = new Set(['possible_obstacle', 'level_change', 'overhead', 'person']);

/** How an item may be mentioned on HeyNavi's own initiative. */
export type Mention = 'obstacle' | 'visible' | 'uncertain' | 'text';

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

type Judged = Pick<MemoryItem, 'kind' | 'grounded' | 'band' | 'importance'>;

/** Relevant to walking at all: a walking kind that Spark does not rate "low". */
export function walkingRelevant(item: Pick<MemoryItem, 'kind' | 'importance'>): boolean {
  return WALKING_KINDS.has(item.kind) && item.importance !== 'low';
}

/**
 * A hazard SAM confirmed: a level change, or a possible obstacle or overhead thing that Spark puts
 * in the walking area ("high"), a possible obstacle only in the lower or middle of the view.
 */
export function isHazard(item: Judged): boolean {
  if (item.grounded !== true) return false;
  if (item.kind === 'level_change') return item.importance !== 'low';
  if (item.importance !== 'high') return false;
  return item.kind === 'overhead' || (item.kind === 'possible_obstacle' && item.band !== 'upper');
}

/** How `item` may be mentioned proactively at `verbosity`, or null when it must not be. */
export function mention(item: Judged, verbosity: Verbosity): Mention | null {
  if (item.kind === 'text') return verbosity === 'detailed' && item.importance !== 'low' ? 'text' : null;
  if (!walkingRelevant(item)) return null;
  if (verbosity === 'quiet' && item.importance !== 'high') return null;
  if (item.grounded === true) return isHazard(item) && item.kind !== 'level_change' ? 'obstacle' : 'visible';
  // SAM did not find it, or did not check: no proof either way. Only things Spark puts in the
  // walking area that could be in the way are said, hedged.
  return item.importance === 'high' && UNCERTAIN_KINDS.has(item.kind) ? 'uncertain' : null;
}

/** The spoken sentence for one item, or null when it would break the wording rules. */
export function itemLine(item: MemoryItem, frame: HoldFrame = 'camera', how: Mention | null = mention(item, 'detailed')): string | null {
  let line: string;
  if (item.kind === 'text') {
    if (item.text) {
      const withText = scenePhrases.text(item, item.text, frame);
      if (unspeakableReason(withText) == null) return withText;
    }
    line = scenePhrases.textUnreadable(item, frame);
  } else if (how === 'obstacle') {
    line = scenePhrases.obstacle(item, frame);
  } else if (how === 'visible') {
    line = scenePhrases.visible(item, frame);
  } else if (how === 'uncertain') {
    line = scenePhrases.uncertain(item, frame);
  } else {
    line = scenePhrases.item(item, frame);
  }
  return unspeakableReason(line) == null ? line : null;
}

function priorityOf(item: Judged, how: Mention): 1 | 2 | 3 {
  if (isHazard(item)) return 1;
  if (how === 'text' || item.kind === 'landmark') return 3;
  return 2;
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
  const frame = input.frame ?? 'camera';
  const reported = rank(merged.reported);
  const summary = summaryLine(reply.summary);

  if (input.describe) {
    const named = summary ? mentionedIn(summary, reported) : [];
    // Asked for, so unchecked items count too; only what SAM looked for and did not find is left out.
    const extras = reported
      .filter((i) => !named.includes(i) && i.grounded !== false)
      .flatMap((i) => (itemLine(i, frame, null) == null ? [] : [i]))
      .slice(0, ATTENTION.describeMaxItems);
    const parts = [summary, extras.length > 0 ? scenePhrases.items(extras, frame) : null].filter(Boolean);
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
        spokenKeys: remember(state, safe === text ? [...named, ...extras].map((i) => i.key) : [], now),
      },
      note: 'describe',
    };
  }

  if (!state.firstLookDone) {
    const shown = summary
      ? []
      : reported.filter((i) => i.grounded === true && walkingRelevant(i) && itemLine(i, frame, null) != null).slice(0, 2);
    const text = summary ?? (shown.length > 0 ? scenePhrases.items(shown, frame) : null);
    const next: PolicyState = { ...state, firstLookDone: true };
    if (!text || unspeakableReason(text) != null) {
      return { announcement: null, spokenKeys: [], state: next, note: text ? 'unspeakable' : 'nothing-new' };
    }
    const keys = (summary ? mentionedIn(summary, reported) : shown).map((i) => i.key);
    return {
      announcement: cameraLine('scene:first-look', text, 2, 0, ATTENTION.ttlMs.firstLook),
      spokenKeys: keys,
      state: {
        ...next,
        spokenAt: recordSpoken(state, now),
        summarySpokenAt: summary ? now : state.summarySpokenAt,
        spokenKeys: remember(state, keys, now),
      },
      note: 'first-look',
    };
  }

  const freshKeys = new Set(merged.fresh.map((i) => i.key));
  const unspoken = (i: MemoryItem) => {
    const last = Math.max(i.lastSpokenAt ?? -Infinity, state.spokenKeys[i.key] ?? -Infinity);
    return now - last > dedupeMsFor(i);
  };
  const eligible = reported.filter(
    (i) =>
      mention(i, verbosity) != null &&
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
  const gap = eligible.some(isHazard) ? ATTENTION.obstacleGapMs : ATTENTION.minGapMs;
  if (last != null && now - last < gap) return { announcement: null, spokenKeys: [], state, note: 'gap' };
  if (recent.length >= ATTENTION.maxPerMinute) return { announcement: null, spokenKeys: [], state, note: 'rate' };

  if (wantSummary && summary) {
    const named = mentionedIn(summary, reported);
    // An important item the summary leaves out is said right after it, in the same line.
    const top = eligible.find((i) => i.importance === 'high' && !named.includes(i));
    const topLine = top ? itemLine(top, frame, mention(top, verbosity)) : null;
    const text = topLine ? `${summary} ${topLine}` : summary;
    return {
      announcement: cameraLine('scene:summary', text, 2, ATTENTION.dedupeMs.summary, ATTENTION.ttlMs.camera),
      spokenKeys: [...named, ...(topLine && top ? [top] : [])].map((i) => i.key),
      state: {
        ...state,
        spokenAt: recordSpoken(state, now),
        summarySpokenAt: now,
        spokenKeys: remember(state, [...named, ...(topLine && top ? [top] : [])].map((i) => i.key), now),
      },
      note: 'summary',
    };
  }

  // Confirmed hazards first, then the usual ranking (which already puts walking kinds first).
  const ordered = [...eligible.filter(isHazard), ...eligible.filter((i) => !isHazard(i))];
  const lines = ordered.flatMap((item) => {
    const how = mention(item, verbosity);
    const line = how ? itemLine(item, frame, how) : null;
    return line && how ? [{ item, line, how }] : [];
  });
  const [first, second] = lines;
  if (first) {
    const words = (text: string) => text.split(/\s+/).length;
    const both = second != null && words(first.line) + words(second.line) <= ATTENTION.maxLineWords;
    const picked = both ? [first, second] : [first];
    const priority = priorityOf(first.item, first.how);
    // Two obstacles read as one sentence: "Possible obstacles: a box …, and a bag …".
    const text =
      both && first.how === 'obstacle' && second.how === 'obstacle'
        ? scenePhrases.obstacles([first.item, second.item], frame)
        : picked.map((p) => p.line).join(' ');
    const keys = picked.map((p) => p.item.key);
    return {
      announcement: cameraLine(
        `scene:item:${keys.join('+')}`,
        unspeakableReason(text) == null ? text : first.line,
        priority,
        dedupeMsFor(first.item),
        ATTENTION.ttlMs.camera,
      ),
      spokenKeys: keys,
      state: { ...state, spokenAt: recordSpoken(state, now), spokenKeys: remember(state, keys, now) },
      note: 'item',
    };
  }
  return { announcement: null, spokenKeys: [], state, note: 'unspeakable' };
}
