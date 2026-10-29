/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { METRICS_TAG, metricsLogLine, summarizeFrames, type FrameMetrics } from './metrics.ts';

function frameMetrics(i: number, extra: Partial<FrameMetrics> = {}): FrameMetrics {
  return {
    frameId: i,
    captureMs: 100 + i,
    processMs: 20,
    rttMs: 400 + 10 * i,
    samMs: 350,
    totalMs: 550,
    detections: i % 2,
    bestConfidence: i % 2 ? 0.876 : null,
    ...extra,
  };
}

describe('summarizeFrames', () => {
  it('reports p50/p95 of every stage and skips missing values', () => {
    const frames = Array.from({ length: 10 }, (_, i) => frameMetrics(i));
    const summary = summarizeFrames(frames);
    assert.equal(summary.frames, 10);
    assert.deepEqual(summary.rttMs, { p50: 445, p95: 486 });
    assert.deepEqual(summary.samMs, { p50: 350, p95: 350 });
    assert.deepEqual(summary.bestConfidence, { p50: 0.88, p95: 0.88 }, 'nulls skipped, 2 digits');
  });

  it('is all null for no frames', () => {
    assert.deepEqual(summarizeFrames([]), {
      frames: 0,
      captureMs: null,
      processMs: null,
      rttMs: null,
      samMs: null,
      totalMs: null,
      detections: null,
      bestConfidence: null,
    });
  });
});

describe('metricsLogLine', () => {
  it('is the tag followed by one JSON object', () => {
    const line = metricsLogLine('stop', 'chair', [frameMetrics(1, { samMs: null })], 2);
    assert.ok(line.startsWith(`${METRICS_TAG} {`));
    const json = JSON.parse(line.slice(METRICS_TAG.length + 1));
    assert.equal(json.reason, 'stop');
    assert.equal(json.concept, 'chair');
    assert.equal(json.failures, 2);
    assert.equal(json.frames, 1);
    assert.equal(json.samMs, null);
    assert.deepEqual(json.rttMs, { p50: 410, p95: 410 });
  });
});
