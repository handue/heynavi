/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { METRICS_TAG } from '../session/metrics.ts';
import { createStopLatencyMeter, stopLatencyLogLine } from './stop-latency.ts';

describe('stop latency', () => {
  it('measures stop request -> the speech playing then has stopped', () => {
    const meter = createStopLatencyMeter();
    meter.requested('button', 1000, [7]);
    assert.equal(meter.ended(8, 1050), null, 'another utterance');
    assert.deepEqual(meter.ended(7, 1120), { source: 'button', ms: 120 });
    assert.equal(meter.ended(7, 1200), null, 'counted once');
  });

  it('waits for every utterance that was playing', () => {
    const meter = createStopLatencyMeter();
    meter.requested('voice', 0, [1, 2]);
    assert.equal(meter.ended(1, 40), null);
    assert.deepEqual(meter.ended(2, 95), { source: 'voice', ms: 95 });
  });

  it('counts a stop with nothing playing, without a sample', () => {
    const meter = createStopLatencyMeter();
    meter.requested('magic-tap', 0, []);
    assert.deepEqual(meter.summary(), { samples: [], p50: null, p95: null, silentStops: 1 });
  });

  it('summarizes p50 / p95 and logs one tagged line', () => {
    const meter = createStopLatencyMeter();
    [100, 120, 140, 400].forEach((ms, i) => {
      meter.requested(i % 2 ? 'voice' : 'button', 0, [i]);
      meter.ended(i, ms);
    });
    const summary = meter.summary();
    assert.equal(summary.p50, 130);
    assert.equal(summary.p95, 361);
    assert.equal(summary.samples.length, 4);
    const line = stopLatencyLogLine(summary);
    assert.ok(line.startsWith(`${METRICS_TAG} `));
    const json = JSON.parse(line.slice(METRICS_TAG.length + 1));
    assert.equal(json.reason, 'stop-latency');
    assert.deepEqual(json.samples[1], { source: 'voice', ms: 120 });
  });

  it('logs a stop with nothing playing as well, marked as silent', () => {
    const meter = createStopLatencyMeter();
    meter.requested('button', 0, []);
    const json = JSON.parse(stopLatencyLogLine(meter.summary(), { silentStop: 'button' }).slice(METRICS_TAG.length + 1));
    assert.equal(json.silentStop, 'button');
    assert.equal(json.silentStops, 1);
  });
});
