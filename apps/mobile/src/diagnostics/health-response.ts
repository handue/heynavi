/** Interprets a GET /health response. Pure, so it runs under `node --test`. */

export const UNEXPECTED_HEALTH_RESPONSE =
  'Unexpected /health response (is this the HeyNavi backend on port 8000?)';

type HealthBody = { ok?: unknown; key_configured?: unknown; version?: unknown };

/**
 * `body` is the parsed JSON, or null when it was not JSON. Only HTTP 2xx with `{"ok": true}` is
 * a reachable HeyNavi backend; any other server on that address gets an explanatory error.
 */
export function interpretHealthResponse(
  httpOk: boolean,
  status: number,
  body: unknown,
): { ok: boolean; keyConfigured: boolean | null; version: string | null; error: string | null } {
  const health = (typeof body === 'object' && body !== null ? body : {}) as HealthBody;
  const ok = httpOk && health.ok === true;
  return {
    ok,
    keyConfigured: typeof health.key_configured === 'boolean' ? health.key_configured : null,
    version: typeof health.version === 'string' ? health.version : null,
    error: ok ? null : httpOk ? UNEXPECTED_HEALTH_RESPONSE : `HTTP ${status}`,
  };
}
