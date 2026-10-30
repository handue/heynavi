/**
 * Runtime configuration from EXPO_PUBLIC_* variables in apps/mobile/.env (see .env.example).
 * Expo inlines these at bundle time, so they must be read with dot notation exactly as below.
 * Changing them needs a full app reload.
 */

import { getSettings } from '@/settings/app-settings';

/**
 * Base URL of the HeyNavi FastAPI backend from the build, without a trailing slash.
 * The localhost fallback only works in the iOS Simulator: a physical iPhone needs the
 * Mac's LAN IP, e.g. http://192.168.1.23:8000.
 */
export const buildApiBaseUrl: string = stripTrailingSlash(
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000',
);

/**
 * The backend to call now: the URL set at runtime (Settings, or a heynavi://backend?url= link
 * pushed from the Mac when its tunnel starts), else the one from the build.
 */
export function apiBaseUrl(): string {
  return getSettings().apiUrl ?? buildApiBaseUrl;
}

/**
 * Per-install app token sent as X-HeyNavi-Token. This is NOT a secret: it ships inside the
 * app bundle. It must equal the backend's HEYNAVI_APP_TOKEN. The Meta API key never lives here.
 */
export const appToken: string = process.env.EXPO_PUBLIC_HEYNAVI_TOKEN ?? '';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
