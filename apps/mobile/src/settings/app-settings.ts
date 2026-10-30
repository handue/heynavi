/**
 * App settings that outlive a session (wireframe 07): onboarding done, speech speed, update
 * level, automatic announcements, and a backend URL that can change without a rebuild (the Mac's
 * tunnel URL changes each time it starts). Kept as JSON in the app's documents directory.
 */
import { File, Paths } from 'expo-file-system';

import { normalizeSettings, type AppSettings } from '@/settings/settings-schema';

const FILE_NAME = 'heynavi-settings.json';

let current: AppSettings | null = null;
const listeners = new Set<() => void>();

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

function load(): AppSettings {
  try {
    const f = file();
    if (f.exists) return normalizeSettings(JSON.parse(f.textSync()));
  } catch (e) {
    console.warn('[settings] could not read settings; using defaults', e);
  }
  return normalizeSettings({});
}

export function getSettings(): AppSettings {
  current ??= load();
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  current = normalizeSettings({ ...getSettings(), ...patch });
  try {
    file().writeSync(JSON.stringify(current));
  } catch (e) {
    console.warn('[settings] could not save settings', e);
  }
  for (const listener of listeners) listener();
  return current;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
