/**
 * Announcement engine (ARCHITECTURE 6): one utterance at a time, priority preemption, dedupe,
 * TTL and stale-goal dropping. The speaker, clock and timers are injected so every rule is
 * unit-testable without expo-speech.
 */
import type { AnnounceEffect, Channel, Lang } from './types.ts';

export type Announcement = Omit<AnnounceEffect, 'type'>;

export type SpeakCallbacks = {
  onStart?: () => void;
  onDone: () => void;
  onStopped: () => void;
};

/** expo-speech queues speak() calls, so the announcer always calls stop() before preempting. */
export type Speaker = {
  speak(text: string, lang: Lang, callbacks: SpeakCallbacks): void;
  stop(): void;
};

export type DropReason = 'stale_goal' | 'duplicate' | 'expired' | 'preempted' | 'cleared';

export type AnnouncerOptions = {
  now: () => number;
  /** Called for every announcement that is never spoken (or cut off), for logs and tests. */
  onDrop?: (announcement: Announcement, reason: DropReason) => void;
  /** Called when the speaker reports that an announcement started playing (latency metrics). */
  onSpeechStart?: (announcement: Announcement, at: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type Announcer = {
  /** Returns false when the announcement was dropped at once. */
  announce(announcement: Announcement): boolean;
  /** Drops queued (and stops speaking) announcements that belong to another goal. */
  setGoal(goalId: string | null): void;
  /** Stops speech and empties the queue. */
  clear(): void;
  /** Drops queued lines of one channel, and stops the current line if it is one. */
  clearChannel(channel: Channel): void;
  /** Speaks the last utterance again, as a priority-0 reply. */
  repeat(): boolean;
  readonly speaking: Announcement | null;
  readonly lastUtterance: Announcement | null;
  readonly queued: readonly Announcement[];
};

/**
 * iOS never fires onError, and a lost onDone would block the queue forever. An utterance that
 * runs longer than this is treated as finished.
 */
export function watchdogMs(text: string): number {
  return Math.min(20_000, 2000 + text.length * 150);
}

type Entry = Announcement & { enqueuedAt: number; seq: number };

export function createAnnouncer(speaker: Speaker, options: AnnouncerOptions): Announcer {
  const { now, onDrop } = options;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let goalId: string | null = null;
  let queue: Entry[] = [];
  let current: Entry | null = null;
  let watchdog: unknown = null;
  /** Bumped whenever the current utterance ends or is replaced; stale callbacks compare it. */
  let token = 0;
  let seq = 0;
  let lastUtterance: Announcement | null = null;
  const spokenAt = new Map<string, number>();

  const drop = (entry: Announcement, reason: DropReason) => onDrop?.(strip(entry), reason);
  const isStale = (a: Announcement) => a.goalId != null && a.goalId !== goalId;
  const isDuplicate = (a: Announcement, t: number) => {
    const last = spokenAt.get(a.key);
    return a.dedupeMs > 0 && last != null && t - last < a.dedupeMs;
  };

  function endCurrent() {
    token++;
    if (watchdog != null) clearTimer(watchdog);
    watchdog = null;
    current = null;
  }

  function speakNow(entry: Entry) {
    const t = now();
    const mine = ++token;
    current = entry;
    spokenAt.set(entry.key, t);
    lastUtterance = strip(entry);
    const finished = () => {
      if (mine !== token) return;
      endCurrent();
      pump();
    };
    watchdog = setTimer(() => {
      if (mine !== token) return;
      speaker.stop();
      finished();
    }, watchdogMs(entry.text));
    speaker.speak(entry.text, entry.lang, {
      onStart: () => {
        if (mine === token) options.onSpeechStart?.(strip(entry), now());
      },
      onDone: finished,
      onStopped: finished,
    });
  }

  function pump() {
    while (!current && queue.length > 0) {
      const next = queue.shift()!;
      const t = now();
      if (isStale(next)) drop(next, 'stale_goal');
      else if (t - next.enqueuedAt > next.ttlMs) drop(next, 'expired');
      else if (isDuplicate(next, t)) drop(next, 'duplicate');
      else speakNow(next);
    }
  }

  function stopCurrent(reason: DropReason) {
    if (!current) return;
    const cut = current;
    endCurrent();
    speaker.stop();
    drop(cut, reason);
  }

  function announce(announcement: Announcement): boolean {
    const t = now();
    if (isStale(announcement)) {
      drop(announcement, 'stale_goal');
      return false;
    }
    if (isDuplicate(announcement, t) || current?.key === announcement.key) {
      drop(announcement, 'duplicate');
      return false;
    }
    // A newer message with the same key replaces the queued one.
    queue = queue.filter((q) => {
      if (q.key !== announcement.key) return true;
      drop(q, 'duplicate');
      return false;
    });
    const entry: Entry = { ...announcement, enqueuedAt: t, seq: seq++ };
    if (current && entry.priority < current.priority) {
      stopCurrent('preempted');
      speakNow(entry);
      return true;
    }
    queue.push(entry);
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    pump();
    return true;
  }

  return {
    announce,

    setGoal(id) {
      goalId = id;
      queue = queue.filter((q) => {
        if (!isStale(q)) return true;
        drop(q, 'stale_goal');
        return false;
      });
      if (current && isStale(current)) {
        stopCurrent('stale_goal');
        pump();
      }
    },

    clear() {
      for (const q of queue) drop(q, 'cleared');
      queue = [];
      if (current) stopCurrent('cleared');
      else speaker.stop();
    },

    clearChannel(channel) {
      queue = queue.filter((q) => {
        if (q.channel !== channel) return true;
        drop(q, 'cleared');
        return false;
      });
      if (current?.channel === channel) {
        stopCurrent('cleared');
        pump();
      }
    },

    repeat() {
      if (!lastUtterance) return false;
      return announce({
        ...lastUtterance,
        key: `repeat:${seq}`,
        priority: 0,
        dedupeMs: 0,
        goalId: null,
        ttlMs: 5000,
        // A repeated camera line is now a reply: pausing updates must not cut it off.
        channel: 'reply',
      });
    },

    get speaking() {
      return current ? strip(current) : null;
    },
    get lastUtterance() {
      return lastUtterance;
    },
    get queued() {
      return queue.map(strip);
    },
  };
}

function strip(entry: Announcement): Announcement {
  const { key, priority, text, lang, ttlMs, dedupeMs, goalId, channel } = entry;
  return channel === undefined
    ? { key, priority, text, lang, ttlMs, dedupeMs, goalId }
    : { key, priority, text, lang, ttlMs, dedupeMs, goalId, channel };
}
