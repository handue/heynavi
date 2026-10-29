/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNEXPECTED_HEALTH_RESPONSE, interpretHealthResponse } from './health-response.ts';

describe('interpretHealthResponse', () => {
  it('accepts HTTP 2xx with {"ok": true}', () => {
    assert.deepEqual(
      interpretHealthResponse(true, 200, { ok: true, key_configured: false, version: '0.1.0' }),
      { ok: true, keyConfigured: false, version: '0.1.0', error: null },
    );
  });

  it('flags a 2xx response that is not the HeyNavi backend', () => {
    for (const body of [{ ok: false }, {}, { status: 'ok' }, null, 'hello', [true]]) {
      const result = interpretHealthResponse(true, 200, body);
      assert.equal(result.ok, false);
      assert.equal(result.error, UNEXPECTED_HEALTH_RESPONSE);
    }
    assert.equal(
      UNEXPECTED_HEALTH_RESPONSE,
      'Unexpected /health response (is this the HeyNavi backend on port 8000?)',
    );
  });

  it('reports the HTTP status for non-2xx responses', () => {
    assert.deepEqual(interpretHealthResponse(false, 401, { ok: true }), {
      ok: false,
      keyConfigured: null,
      version: null,
      error: 'HTTP 401',
    });
  });

  it('ignores mistyped fields', () => {
    const result = interpretHealthResponse(true, 200, { ok: true, key_configured: 'yes', version: 3 });
    assert.equal(result.keyConfigured, null);
    assert.equal(result.version, null);
  });
});
