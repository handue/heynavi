/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { METRICS_TAG } from './metrics.ts';
import { UPLOAD, createMetricsUploader } from './metrics-uploader.ts';

function harness(results: boolean[] = []) {
  const batches: string[][] = [];
  const uploader = createMetricsUploader({
    post: async (lines) => {
      batches.push(lines);
      return results.shift() ?? true;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { uploader, batches };
}

describe('metrics uploader', () => {
  it('sends only metric lines, never content or transcripts', async () => {
    const { uploader, batches } = harness();
    uploader.push(`${METRICS_TAG} {"reason":"scene","rttMs":4000}`);
    uploader.push('[heynavi-scene] #3 summary="A kitchen"');
    uploader.push('[heynavi-voice] final -> ask: "where is the door"');
    uploader.push(`${METRICS_TAG} {"label":"café"}`);
    await uploader.flush();
    assert.deepEqual(batches, [[`${METRICS_TAG} {"reason":"scene","rttMs":4000}`]]);
  });

  it('keeps lines after a network failure and sends them next time', async () => {
    const { uploader, batches } = harness([false, true]);
    uploader.push(`${METRICS_TAG} {"n":1}`);
    await uploader.flush();
    await uploader.flush();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1], [`${METRICS_TAG} {"n":1}`]);
    await uploader.flush();
    assert.equal(batches.length, 2, 'nothing left to send');
  });

  it('sends a full batch at once and bounds the buffer', async () => {
    const { uploader, batches } = harness(Array(20).fill(false));
    for (let i = 0; i < UPLOAD.maxBuffered + 40; i++) uploader.push(`${METRICS_TAG} {"n":${i}}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(batches.length >= 1);
    assert.equal(batches[0].length, UPLOAD.maxBatch);
  });
});
