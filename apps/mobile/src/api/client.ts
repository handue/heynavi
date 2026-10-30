import { uuid } from 'expo';

import {
  parseDetectResponse,
  parseErrorBody,
  parseRetryAfter,
  type ApiError,
  type DetectRequest,
  type DetectResult,
} from '@/api/detect-response';
import { parseAskResponse, type AskRequest, type AskResult } from '@/api/ask-response';
import { parseSceneResponse, type SceneRequest, type SceneResult } from '@/api/scene-response';
import { apiBaseUrl, appToken } from '@/config';
import { round } from '@/lib/stats';

/** Above the backend's own SAM timeout, so a slow SAM call comes back as a typed 504 first. */
export const DETECT_TIMEOUT_MS = 6000;

/** Above the backend's own Spark timeout (12 s), so a slow scene call comes back as a typed 504 first. */
export const SCENE_TIMEOUT_MS = 15_000;

type PostResult<T> = { ok: true; data: T; rttMs: number } | { ok: false; error: ApiError };

/**
 * POST /v1/detect. Never throws: failures come back as a typed `error`. Aborting `signal` (stop,
 * pause, new goal) cancels the request and yields kind "aborted". Only the public app token is
 * sent; the Meta key never leaves the backend.
 */
export function detect(request: DetectRequest, { signal }: { signal?: AbortSignal } = {}): Promise<DetectResult> {
  return postJson('/v1/detect', request, DETECT_TIMEOUT_MS, parseDetectResponse, signal);
}

/**
 * POST /v1/metrics. True when the lines are done with: accepted, or refused for good (4xx). False
 * on a network failure or 5xx, so the caller keeps them for the next try.
 */
export async function postMetrics(sessionId: string, lines: string[]): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(appToken ? { 'X-HeyNavi-Token': appToken } : {}) },
      body: JSON.stringify({ session_id: sessionId, lines }),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** POST /v1/ask: a question about the current view. Same never-throws contract as detect(). */
export function askQuestion(request: AskRequest, { signal }: { signal?: AbortSignal } = {}): Promise<AskResult> {
  return postJson('/v1/ask', request, SCENE_TIMEOUT_MS, parseAskResponse, signal);
}

/** POST /v1/scene, with the same never-throws contract as detect(). */
export function describeScene(request: SceneRequest, { signal }: { signal?: AbortSignal } = {}): Promise<SceneResult> {
  return postJson('/v1/scene', request, SCENE_TIMEOUT_MS, parseSceneResponse, signal);
}

async function postJson<T>(
  path: string,
  request: unknown,
  timeoutMs: number,
  parse: (body: unknown) => T | null,
  signal: AbortSignal | undefined,
): Promise<PostResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort);

  const startedAt = performance.now();
  const interrupted = (): PostResult<T> | null =>
    timedOut
      ? { ok: false, error: { kind: 'timeout', message: `No response within ${timeoutMs / 1000} s` } }
      : controller.signal.aborted
        ? { ok: false, error: { kind: 'aborted', message: 'Request cancelled' } }
        : null;

  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
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
    const data = parse(body);
    if (!data) {
      return {
        ok: false,
        error: { kind: 'bad_response', status: response.status, message: `Not a ${path} response` },
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
