import { uuid } from 'expo';
import { useEffect, useRef, useState } from 'react';

import { apiBaseUrl, appToken } from '@/config';
import { interpretHealthResponse } from '@/diagnostics/health-response';
import type { BackendReport } from '@/diagnostics/report';
import { round } from '@/lib/stats';

const TIMEOUT_MS = 4000;

export const UNREACHABLE_HELP =
  'Check that the iPhone and the Mac are on the same Wi-Fi, that EXPO_PUBLIC_API_URL in ' +
  'apps/mobile/.env uses the Mac’s LAN IP (not localhost) and port 8000, that the backend was ' +
  'started with --host 0.0.0.0, and that HeyNavi is allowed under Settings, Privacy & Security, ' +
  'Local Network. Reload the app after editing .env.';

export function useBackendPing() {
  const [result, setResult] = useState<BackendReport | null>(null);
  const [pending, setPending] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  async function ping() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    const report = await pingHealth(controller);
    // A newer ping (or unmount) replaced this one.
    if (controllerRef.current !== controller) return;
    controllerRef.current = null;
    setResult(report);
    setPending(false);
  }

  return { url: `${apiBaseUrl()}/health`, result, pending, ping };
}

/** GET /health with a hard timeout. Never throws; failures come back in `error`. */
async function pingHealth(controller: AbortController): Promise<BackendReport> {
  const url = `${apiBaseUrl()}/health`;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();
  const at = () => new Date().toISOString();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Request-Id': uuid.v4(),
        ...(appToken ? { 'X-HeyNavi-Token': appToken } : {}),
      },
      signal: controller.signal,
    });
    const latencyMs = round(performance.now() - startedAt);
    const body: unknown = await response.json().catch(() => null);
    const health = interpretHealthResponse(response.ok, response.status, body);
    return {
      url,
      ok: health.ok,
      status: response.status,
      latencyMs,
      keyConfigured: health.keyConfigured,
      version: health.version,
      error: health.error,
      at: at(),
    };
  } catch (e) {
    const message = controller.signal.aborted
      ? `No response within ${TIMEOUT_MS / 1000} s`
      : e instanceof Error
        ? e.message
        : String(e);
    return {
      url,
      ok: false,
      status: null,
      latencyMs: null,
      keyConfigured: null,
      version: null,
      error: message,
      at: at(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
