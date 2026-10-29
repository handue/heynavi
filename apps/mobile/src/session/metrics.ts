/** Per-frame stage timings and their p50/p95 summary. Pure, so it runs under `node --test`. */
import { percentile, round } from '../lib/stats.ts';

export type FrameMetrics = {
  frameId: number;
  /** takePictureAsync. */
  captureMs: number;
  /** Resize + JPEG encode. */
  processMs: number;
  /** Request sent -> response parsed, on the phone. */
  rttMs: number;
  /** Backend-reported sam-3.1 time; null when the backend sent no timings. */
  samMs: number | null;
  /** Cycle start (capture) -> response parsed. */
  totalMs: number;
  detections: number;
  bestConfidence: number | null;
};

export type Spread = { p50: number; p95: number };

export type MetricsSummary = {
  frames: number;
  captureMs: Spread | null;
  processMs: Spread | null;
  rttMs: Spread | null;
  samMs: Spread | null;
  totalMs: Spread | null;
  detections: Spread | null;
  bestConfidence: Spread | null;
};

const METRIC_KEYS = [
  'captureMs',
  'processMs',
  'rttMs',
  'samMs',
  'totalMs',
  'detections',
  'bestConfidence',
] as const;

export function spread(values: readonly number[], digits = 0): Spread | null {
  if (values.length === 0) return null;
  return {
    p50: round(percentile(values, 50)!, digits),
    p95: round(percentile(values, 95)!, digits),
  };
}

export function summarizeFrames(frames: readonly FrameMetrics[]): MetricsSummary {
  const summary: MetricsSummary = {
    frames: frames.length,
    captureMs: null,
    processMs: null,
    rttMs: null,
    samMs: null,
    totalMs: null,
    detections: null,
    bestConfidence: null,
  };
  for (const key of METRIC_KEYS) {
    const values = frames.map((f) => f[key]).filter((v): v is number => v != null);
    summary[key] = spread(values, key === 'bestConfidence' ? 2 : 0);
  }
  return summary;
}

export const METRICS_TAG = '[heynavi-metrics]';

/** One Metro-log line: the tag, then JSON. Holds numbers and the concept only, never image data. */
export function metricsLogLine(
  reason: 'periodic' | 'stop',
  concept: string,
  frames: readonly FrameMetrics[],
  failures: number,
): string {
  return `${METRICS_TAG} ${JSON.stringify({ reason, concept, failures, ...summarizeFrames(frames) })}`;
}
