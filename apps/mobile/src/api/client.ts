import { uuid } from 'expo';

import {
  parseDetectResponse,
  parseErrorBody,
  parseRetryAfter,
  type DetectRequest,
  type DetectResult,
} from '@/api/detect-response';
import { apiBaseUrl, appToken } from '@/config';
import { round } from '@/lib/stats';

/** Above the backend's own SAM timeout, so a slow SAM call comes back as a typed 504 first. */
export const DETECT_TIMEOUT_MS = 6000;

/**
 * POST /v1/detect. Never throws: failures come back as a typed `error`. Aborting `signal` (stop,
 * pause, new goal) cancels the request and yields kind "aborted". Only the public app token is
 * sent; the Meta key never leaves the backend.
 */
export async function detect(
  request: DetectRequest,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DetectResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DETECT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort);

  const startedAt = performance.now();
  const interrupted = (): DetectResult | null =>
    timedOut
      ? { ok: false, error: { kind: 'timeout', message: `No response within ${DETECT_TIMEOUT_MS / 1000} s` } }
      : controller.signal.aborted
        ? { ok: false, error: { kind: 'aborted', message: 'Request cancelled' } }
        : null;

  try {
    const response = await fetch(`${apiBaseUrl}/v1/detect`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Request-Id': uuid.v4(),
        ...(appToken ? { 'X-HeyNavi-Token': appToken } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    // The timeout or a cancel can land while the body is still being read.
    const cut = interrupted();
    if (cut) return cut;
    const rttMs = round(performance.now() - startedAt);
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), Date.now());
      return {
        ok: false,
        error: {
          kind: 'http',
          status: response.status,
          ...parseErrorBody(response.status, body),
          ...(retryAfterMs == null ? {} : { retryAfterMs }),
        },
      };
    }
    const data = parseDetectResponse(body);
    if (!data) {
      return {
        ok: false,
        error: { kind: 'bad_response', status: response.status, message: 'Not a /v1/detect response' },
      };
    }
    return { ok: true, data, rttMs };
  } catch (e) {
    return (
      interrupted() ?? {
        ok: false,
        error: { kind: 'network', message: e instanceof Error ? e.message : String(e) },
      }
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
