/** Pure TTS helpers (type imports only), so they run under `node --test`. */
import type { Voice } from 'expo-speech';
import type { ExpoSpeechRecognitionModule, SetCategoryOptions } from 'expo-speech-recognition';

/** iOS voice identifiers (observed format, not a documented contract): "com.apple.voice.premium.*". */
export function isPremiumVoice(voice: Pick<Voice, 'identifier'>): boolean {
  return voice.identifier.includes('.premium.');
}

/** expo-speech only reports Default/Enhanced, so Premium comes from the identifier. */
export function voiceQualityLabel(voice: Pick<Voice, 'identifier' | 'quality'>): string {
  return isPremiumVoice(voice) ? 'Premium' : voice.quality;
}

/**
 * Best installed voice for a language. expo-speech reports only Default/Enhanced quality, so
 * this also reads iOS voice identifiers (observed format, not a documented contract):
 * "com.apple.voice.premium.*" beats enhanced, and novelty/Eloquence voices are avoided.
 */
export function pickVoice<V extends Pick<Voice, 'identifier' | 'name' | 'language' | 'quality'>>(
  voices: readonly V[],
  lang: string,
): V | null {
  const prefix = lang.slice(0, 2).toLowerCase();
  const normalize = (language: string) => language.replace('_', '-').toLowerCase();
  const score = (v: V) =>
    (isPremiumVoice(v) ? 5 : 0) +
    // VoiceQuality.Enhanced; compared as a string so this module keeps type-only imports.
    ((v.quality as string) === 'Enhanced' ? 4 : 0) +
    (normalize(v.language) === lang.toLowerCase() ? 1 : 0) -
    (/speech\.synthesis\.voice|eloquence/i.test(v.identifier) ? 10 : 0);
  const candidates = voices.filter((v) => normalize(v.language).startsWith(prefix));
  candidates.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

/** getAvailableVoicesAsync(), or [] when it throws or rejects. */
export async function loadVoices(getVoices: () => Promise<Voice[]>): Promise<Voice[]> {
  try {
    return await getVoices();
  } catch {
    return [];
  }
}

export type AudioSessionModule = Pick<
  typeof ExpoSpeechRecognitionModule,
  'setCategoryIOS' | 'setAudioSessionActiveIOS' | 'getAudioSessionCategoryAndOptionsIOS'
>;

export type AudioSessionSnapshot = ReturnType<
  AudioSessionModule['getAudioSessionCategoryAndOptionsIOS']
>;

/**
 * Same category as the recognition session. playAndRecord keeps playing in Silent Mode, and
 * defaultToSpeaker routes it to the loudspeaker instead of the earpiece.
 */
export const TTS_AUDIO_CATEGORY: SetCategoryOptions = {
  category: 'playAndRecord',
  categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
  mode: 'default',
};

/**
 * Configures and activates the shared AVAudioSession before speak(), then reads it back so the
 * report shows what was actually in effect. A null module (Expo Go) changes nothing.
 */
export function prepareTtsAudioSession(
  module: AudioSessionModule | null,
  options: {
    /**
     * Read the session first and skip setCategoryIOS when it already matches. The speaker uses
     * this: these calls are synchronous on the JS thread, and the recognizer has usually set the
     * same category already. The diagnostics report always applies it.
     */
    keepMatching?: boolean;
    /**
     * The caller already saw the session match: skip the read too (only activate). With
     * VoiceOver on, the read alone blocked the JS thread for up to 240 ms on the iPhone 16e.
     */
    knownMatching?: boolean;
    now?: () => number;
  } = {},
): {
  audioSession: AudioSessionSnapshot | null;
  audioSessionError: string | null;
  /** setCategoryIOS was skipped because the session already matched. */
  categoryKept?: boolean;
  /** Time spent in each native call, when `now` is given. */
  timingsMs?: Record<string, number>;
} {
  if (!module) return { audioSession: null, audioSessionError: null };
  let audioSessionError: string | null = null;
  const timingsMs: Record<string, number> = {};
  const attempt = (step: string, fn: () => void) => {
    const started = options.now?.();
    try {
      fn();
    } catch (e) {
      audioSessionError ??= `${step}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (started != null) timingsMs[step] = Math.round(options.now!() - started);
  };
  let audioSession: AudioSessionSnapshot | null = null;
  const read = () =>
    attempt('getAudioSessionCategoryAndOptionsIOS', () => {
      audioSession = module.getAudioSessionCategoryAndOptionsIOS();
    });
  let categoryKept = options.knownMatching === true;
  if (options.keepMatching && !categoryKept) {
    read();
    categoryKept = matchesTtsCategory(audioSession);
  }
  if (!categoryKept) attempt('setCategoryIOS', () => module.setCategoryIOS(TTS_AUDIO_CATEGORY));
  attempt('setAudioSessionActiveIOS', () => module.setAudioSessionActiveIOS(true));
  if (!categoryKept) read();
  const result = { audioSession, audioSessionError };
  if (!options.keepMatching && !options.now) return result;
  return { ...result, categoryKept, ...(options.now ? { timingsMs } : {}) };
}

/** The session already has TTS_AUDIO_CATEGORY: same category and mode, options in any order. */
export function matchesTtsCategory(snapshot: AudioSessionSnapshot | null): boolean {
  if (!snapshot) return false;
  const sorted = (values: readonly string[]) => [...values].sort().join(',');
  return (
    snapshot.category === TTS_AUDIO_CATEGORY.category &&
    snapshot.mode === (TTS_AUDIO_CATEGORY.mode ?? 'default') &&
    sorted(snapshot.categoryOptions) === sorted(TTS_AUDIO_CATEGORY.categoryOptions)
  );
}
