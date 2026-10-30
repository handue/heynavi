/**
 * Stop-latency metric for the VS-1 acceptance check: from the moment a stop is requested (button
 * press, Magic Tap, or the app recognizing a spoken stop command) to the moment the speaker
 * reports that every utterance playing at that moment has stopped (onStopped, or onDone).
 *
 * For a voice stop, t0 is when the recognizer's result reaches the app. The time from the user
 * starting to say "stop" to that interim result cannot be measured in the app (the recognizer
 * gives no timestamps for partial results), so a voice sample understates the felt latency by
 * the recognizer's own delay. Pure, so it runs under `node --test`.
 */
import { percentile, round } from '../lib/stats.ts';
import { METRICS_TAG } from '../session/metrics.ts';

export type StopSource = 'button' | 'magic-tap' | 'voice';

export type StopSample = { source: StopSource; ms: number };

export type StopLatencySummary = {
  samples: StopSample[];
  p50: number | null;
  p95: number | null;
  /** Stops requested while nothing was being spoken (no sample: nothing to cut off). */
  silentStops: number;
};

export type StopLatencyMeter = {
  /** `activeIds`: utterances being spoken when the stop was requested. */
  requested(source: StopSource, at: number, activeIds: readonly number[]): void;
  /** An utterance ended (done or stopped). Returns the sample when it completed one. */
  ended(id: number, at: number): StopSample | null;
  summary(): StopLatencySummary;
};

/** Samples kept for the summary. */
const MAX_SAMPLES = 100;

export function createStopLatencyMeter(): StopLatencyMeter {
  let pending: { source: StopSource; at: number; waiting: Set<number> }[] = [];
  let samples: StopSample[] = [];
  let silentStops = 0;

  return {
    requested(source, at, activeIds) {
      if (activeIds.length === 0) {
        silentStops++;
        return;
      }
      pending.push({ source, at, waiting: new Set(activeIds) });
    },

    ended(id, at) {
      let completed: StopSample | null = null;
      pending = pending.filter((p) => {
        p.waiting.delete(id);
        if (p.waiting.size > 0) return true;
        completed = { source: p.source, ms: round(at - p.at) };
        samples = [...samples, completed].slice(-MAX_SAMPLES);
        return false;
      });
      return completed;
    },

    summary() {
      const values = samples.map((s) => s.ms);
      const p50 = percentile(values, 50);
      const p95 = percentile(values, 95);
      return {
        samples: [...samples],
        p50: p50 == null ? null : round(p50),
        p95: p95 == null ? null : round(p95),
        silentStops,
      };
    },
  };
}

/**
 * One "[heynavi-metrics]" log line with the stop-latency summary so far. `extra` marks why it was
 * logged, e.g. { silentStop: 'button' } for a stop with nothing playing.
 */
export function stopLatencyLogLine(summary: StopLatencySummary, extra: Record<string, string> = {}): string {
  return `${METRICS_TAG} ${JSON.stringify({ reason: 'stop-latency', ...extra, ...summary })}`;
}
