/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NO_FAILURES,
  RETRY,
  errorKindFor,
  recordFailure,
  recordSuccess,
  retryDelayMs,
  withRetryAfter,
  type FailureState,
} from './retry-policy.ts';

describe('retryDelayMs', () => {
  it('backs off 1 s, 2 s, 4 s, then stays at 5 s', () => {
    assert.deepEqual([1, 2, 3, 4, 10].map(retryDelayMs), [1000, 2000, 4000, 5000, 5000]);
  });
});

describe('withRetryAfter', () => {
  it('waits for a longer Retry-After, capped so the failure is spoken again on time', () => {
    assert.equal(withRetryAfter(1000, null), 1000);
    assert.equal(withRetryAfter(4000, 2000), 4000, 'never shorter than the back-off');
    assert.equal(withRetryAfter(1000, 7000), 7000);
    assert.equal(withRetryAfter(1000, 3_600_000), RETRY.maxRetryAfterMs);
    assert.ok(RETRY.maxRetryAfterMs <= RETRY.reannounceMs);
  });
});

describe('recordFailure', () => {
  it('speaks a network failure on the second failure in a row, then every 20 s', () => {
    let state: FailureState = NO_FAILURES;
    const spokenAt: number[] = [];
    for (let t = 0; t <= 45_000; t += 1000) {
      const result = recordFailure(state, 'network', t);
      state = result.state;
      if (result.announce) spokenAt.push(t);
    }
    assert.deepEqual(spokenAt, [1000, 21_000, 41_000]);
    assert.equal(state.count, 46);
  });

  it('speaks slow and unfixable failures at once', () => {
    for (const kind of ['slow', 'unauthorized', 'notConfigured', 'cantAnalyze'] as const) {
      assert.equal(recordFailure(NO_FAILURES, kind, 0).announce, true, kind);
    }
    assert.equal(recordFailure(NO_FAILURES, 'camera', 0).announce, false);
  });

  it('a success ends the streak and reports reconnection only if the user heard about it', () => {
    const quiet = recordFailure(NO_FAILURES, 'network', 0).state;
    assert.deepEqual(recordSuccess(quiet), { state: NO_FAILURES, reconnected: false });
    const spoken = recordFailure(quiet, 'network', 1000).state;
    assert.deepEqual(recordSuccess(spoken), { state: NO_FAILURES, reconnected: true });
    assert.equal(RETRY.reannounceMs, 20_000);
  });
});

describe('errorKindFor', () => {
  it('maps client errors to spoken kinds', () => {
    assert.equal(errorKindFor({ kind: 'network', message: 'Network request failed' }), 'network');
    assert.equal(errorKindFor({ kind: 'timeout', message: '' }), 'slow');
    assert.equal(errorKindFor({ kind: 'bad_response', status: 200, message: '' }), 'server');
    const http = (code: string) => errorKindFor({ kind: 'http', status: 500, code, message: '' });
    assert.equal(http('unauthorized'), 'unauthorized');
    assert.equal(http('key_not_configured'), 'notConfigured');
    assert.equal(http('content_policy_violation'), 'cantAnalyze');
    assert.equal(http('timeout'), 'slow');
    assert.equal(http('rate_limited'), 'server');
    assert.equal(http('upstream_error'), 'server');
  });
});
