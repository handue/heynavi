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
export function prepareTtsAudioSession(module: AudioSessionModule | null): {
  audioSession: AudioSessionSnapshot | null;
  audioSessionError: string | null;
} {
  if (!module) return { audioSession: null, audioSessionError: null };
  let audioSessionError: string | null = null;
  const attempt = (step: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      audioSessionError ??= `${step}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  attempt('setCategoryIOS', () => module.setCategoryIOS(TTS_AUDIO_CATEGORY));
  attempt('setAudioSessionActiveIOS', () => module.setAudioSessionActiveIOS(true));
  let audioSession: AudioSessionSnapshot | null = null;
  attempt('getAudioSessionCategoryAndOptionsIOS', () => {
    audioSession = module.getAudioSessionCategoryAndOptionsIOS();
  });
  return { audioSession, audioSessionError };
}
