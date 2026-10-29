/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDetectResponse, parseDetection, parseErrorBody, parseRetryAfter } from './detect-response.ts';

const detection = {
  box: [0.1, 0.2, 0.3, 0.6],
  confidence: 0.91,
  center_x: 0.2,
  area: 0.08,
  position: 'left',
};

const body = {
  goal_id: 'g1',
  frame_id: 7,
  concept: 'chair',
  image: { width: 567, height: 1008 },
  detections: [detection, { ...detection, confidence: null, position: 'center', center_x: 0.5 }],
  timings_ms: { sam: 357.2, parse: 0.4, total: 380.1 },
};

describe('parseDetectResponse', () => {
  it('parses a contract response', () => {
    const parsed = parseDetectResponse(body);
    assert.ok(parsed);
    assert.equal(parsed.goal_id, 'g1');
    assert.equal(parsed.frame_id, 7);
    assert.deepEqual(parsed.image, { width: 567, height: 1008 });
    assert.equal(parsed.detections.length, 2);
    assert.deepEqual(parsed.detections[0], detection);
    assert.equal(parsed.detections[1].confidence, null);
    assert.deepEqual(parsed.timings_ms, { sam: 357.2, parse: 0.4, total: 380.1 });
  });

  it('accepts "no match": null image and no detections', () => {
    const parsed = parseDetectResponse({ ...body, image: null, detections: [] });
    assert.ok(parsed);
    assert.equal(parsed.image, null);
    assert.deepEqual(parsed.detections, []);
  });

  it('skips malformed detections instead of failing the frame', () => {
    const parsed = parseDetectResponse({
      ...body,
      detections: [
        detection,
        { ...detection, position: 'up' },
        { ...detection, box: [0, 0, 1] },
        { ...detection, confidence: '0.9' },
        { ...detection, center_x: Number.NaN },
        null,
      ],
    });
    assert.equal(parsed?.detections.length, 1);
  });

  it('keeps a frame whose timings are missing', () => {
    const { timings_ms: _omit, ...rest } = body;
    assert.equal(parseDetectResponse(rest)?.timings_ms, null);
  });

  it('rejects bodies that are not a detect response', () => {
    for (const bad of [
      null,
      'ok',
      [],
      { ...body, goal_id: 1 },
      { ...body, frame_id: 1.5 },
      { ...body, frame_id: '7' },
      { ...body, detections: {} },
      { ...body, concept: undefined },
      { ...body, image: { width: 'x', height: 1 } },
    ]) {
      assert.equal(parseDetectResponse(bad), null, JSON.stringify(bad));
    }
  });
});

describe('parseDetection', () => {
  it('copies the box so later mutation cannot leak in', () => {
    const parsed = parseDetection(detection);
    assert.ok(parsed);
    assert.notEqual(parsed.box, detection.box);
  });
});

describe('parseErrorBody', () => {
  it('reads the contract error envelope', () => {
    assert.deepEqual(
      parseErrorBody(502, { error: { code: 'content_policy_violation', message: 'blocked' } }),
      { code: 'content_policy_violation', message: 'blocked' },
    );
    assert.deepEqual(parseErrorBody(401, { error: { code: 'unauthorized', message: 'bad token' } }), {
      code: 'unauthorized',
      message: 'bad token',
    });
  });

  it('falls back to a code from the status', () => {
    assert.deepEqual(parseErrorBody(401, null), { code: 'unauthorized', message: 'HTTP 401' });
    assert.equal(parseErrorBody(422, { detail: [] }).code, 'invalid_request');
    assert.equal(parseErrorBody(429, '').code, 'rate_limited');
    assert.equal(parseErrorBody(504, null).code, 'timeout');
    assert.equal(parseErrorBody(503, null).code, 'upstream_error');
    assert.equal(parseErrorBody(404, null).code, 'http_error');
    assert.equal(parseErrorBody(500, { error: { code: '' } }).code, 'upstream_error');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    assert.equal(parseRetryAfter('7', now), 7000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
    assert.equal(parseRetryAfter('Thu, 29 Oct 2026 12:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Thu, 29 Oct 2026 11:59:00 GMT', now), 0, 'a past date means now');
  });

  it('returns null when the header is missing or unreadable', () => {
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter('', 0), null);
    assert.equal(parseRetryAfter('soon', 0), null);
    assert.equal(parseRetryAfter('-5', 0), null);
  });
});
