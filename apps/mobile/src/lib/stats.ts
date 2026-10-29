/** Pure statistics and formatting helpers for latency measurements. */

export type Summary = {
  n: number;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
};

/**
 * Percentile with linear interpolation between closest ranks (same as NumPy's default).
 * `p` is in [0, 100]. Returns null for an empty list.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  return {
    n: values.length,
    p50: round(percentile(values, 50) ?? 0),
    p95: round(percentile(values, 95) ?? 0),
    mean: round(mean(values) ?? 0),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** "312 ms", or an en dash when there is no value. */
export function formatMs(value: number | null | undefined): string {
  return value == null ? '–' : `${Math.round(value)} ms`;
}

/** Size of a base64 string itself (the upload payload), in KB with one decimal. */
export function base64KB(base64: string): number {
  return round(base64.length / 1024, 1);
}

/** Wall-clock time as HH:MM:SS.mmm in local time. */
export function formatClock(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}
