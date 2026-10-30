/**
 * Sends the app's metric lines to POST /v1/metrics in batches, so runs without Metro (release
 * builds, outdoors) still leave evidence on the backend. Only `[heynavi-metrics]` lines: timings,
 * counts and decisions, never scene content or transcripts. Pure (the POST is injected), so it
 * runs under `node --test`; it never throws and drops lines rather than growing without bound.
 */
import { METRICS_TAG } from './metrics.ts';

export const UPLOAD = {
  flushEveryMs: 15_000,
  maxBatch: 50,
  maxBuffered: 300,
  maxLineChars: 2000,
} as const;

export type MetricsUploader = {
  push(line: string): void;
  /** Sends what is buffered now (the timer does this on its own). */
  flush(): Promise<void>;
  stop(): void;
};

const PRINTABLE = /^[\x20-\x7e]+$/;

export function createMetricsUploader(deps: {
  /** Resolves true when the lines are done (sent, or refused for good); false keeps them for later. */
  post(lines: string[]): Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): MetricsUploader {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let buffer: string[] = [];
  let sending = false;
  const timer = setTimer(() => void flush(), UPLOAD.flushEveryMs);

  async function flush() {
    if (sending || buffer.length === 0) return;
    sending = true;
    const batch = buffer.slice(0, UPLOAD.maxBatch);
    try {
      const ok = await deps.post(batch).catch(() => false);
      if (ok) buffer = buffer.slice(batch.length);
    } finally {
      sending = false;
    }
  }

  return {
    push(line) {
      if (!line.startsWith(`${METRICS_TAG} `) || line.length > UPLOAD.maxLineChars || !PRINTABLE.test(line)) return;
      buffer.push(line);
      if (buffer.length > UPLOAD.maxBuffered) buffer = buffer.slice(-UPLOAD.maxBuffered);
      if (buffer.length >= UPLOAD.maxBatch) void flush();
    },
    flush,
    stop() {
      clearTimer(timer);
      void flush();
    },
  };
}
