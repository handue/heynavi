/**
 * Wraps the announcer's Speaker to know what is physically being spoken: from speak() until the
 * speaker reports onDone or onStopped. The announcer's own `speaking` ends as soon as it calls
 * stop(), before the audio stops, so the echo gate and the stop-latency meter read this instead.
 * Pure (type imports only), so it runs under `node --test`.
 */
import { watchdogMs, type Speaker } from '../agent/announcer.ts';

export type SpeechEvent = { type: 'start' | 'end'; id: number; text: string; at: number };

export type SpeechTracker = {
  /** Pass this to the announcer instead of the raw speaker. */
  readonly speaker: Speaker;
  readonly speaking: boolean;
  /** Text being spoken now (the newest one if two overlap during a hand-over). */
  readonly currentText: string | null;
  /** Text of the utterance that ended most recently. */
  readonly lastText: string | null;
  readonly lastEndedAt: number | null;
  /** Ids of the utterances being spoken now. */
  activeIds(): number[];
  subscribe(listener: (event: SpeechEvent) => void): () => void;
};

export type SpeechTrackerOptions = {
  now: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * If the speaker never reports the end (iOS never fires onError), the utterance counts as ended
 * a little after the announcer's own watchdog would have cut it, so `speaking` cannot stick and
 * block voice commands for good.
 */
export const TRACKER_SLACK_MS = 1000;

export function createSpeechTracker(inner: Speaker, options: SpeechTrackerOptions): SpeechTracker {
  const { now } = options;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const active = new Map<number, { text: string; timer: unknown }>();
  const listeners = new Set<(event: SpeechEvent) => void>();
  let nextId = 0;
  let lastText: string | null = null;
  let lastEndedAt: number | null = null;

  const emit = (event: SpeechEvent) => {
    for (const listener of listeners) listener(event);
  };

  function end(id: number) {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    clearTimer(entry.timer);
    lastText = entry.text;
    lastEndedAt = now();
    emit({ type: 'end', id, text: entry.text, at: lastEndedAt });
  }

  const speaker: Speaker = {
    speak(text, lang, callbacks) {
      const id = ++nextId;
      const timer = setTimer(() => end(id), watchdogMs(text) + TRACKER_SLACK_MS);
      active.set(id, { text, timer });
      emit({ type: 'start', id, text, at: now() });
      inner.speak(text, lang, {
        onStart: callbacks.onStart,
        onDone: () => {
          end(id);
          callbacks.onDone();
        },
        onStopped: () => {
          end(id);
          callbacks.onStopped();
        },
      });
    },
    stop() {
      inner.stop();
    },
  };

  return {
    speaker,
    get speaking() {
      return active.size > 0;
    },
    get currentText() {
      let text: string | null = null;
      for (const entry of active.values()) text = entry.text;
      return text;
    },
    get lastText() {
      return lastText;
    },
    get lastEndedAt() {
      return lastEndedAt;
    },
    activeIds() {
      return [...active.keys()];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
