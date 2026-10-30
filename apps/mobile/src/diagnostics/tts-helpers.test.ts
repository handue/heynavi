/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Voice, VoiceQuality } from 'expo-speech';

import {
  TTS_AUDIO_CATEGORY,
  isPremiumVoice,
  loadVoices,
  pickVoice,
  prepareTtsAudioSession,
  voiceQualityLabel,
  type AudioSessionModule,
  type AudioSessionSnapshot,
} from './tts-helpers.ts';

function voice(identifier: string, quality: 'Default' | 'Enhanced', language = 'en-US'): Voice {
  return { identifier, name: identifier, language, quality: quality as VoiceQuality };
}

describe('voiceQualityLabel', () => {
  it('reports Premium from the identifier', () => {
    const premium = voice('com.apple.voice.premium.en-US.Zoe', 'Enhanced');
    assert.equal(isPremiumVoice(premium), true);
    assert.equal(voiceQualityLabel(premium), 'Premium');
  });

  it('otherwise reports expo-speech quality', () => {
    assert.equal(voiceQualityLabel(voice('com.apple.voice.enhanced.en-US.Zoe', 'Enhanced')), 'Enhanced');
    assert.equal(voiceQualityLabel(voice('com.apple.voice.compact.en-US.Samantha', 'Default')), 'Default');
    assert.equal(isPremiumVoice(voice('com.apple.voice.compact.en-US.Samantha', 'Default')), false);
  });
});

describe('pickVoice', () => {
  const voices = [
    voice('com.apple.voice.compact.en-US.Samantha', 'Default'),
    voice('com.apple.voice.enhanced.en-GB.Daniel', 'Enhanced', 'en-GB'),
    voice('com.apple.voice.premium.en-US.Zoe', 'Enhanced'),
    voice('com.apple.speech.synthesis.voice.Bubbles', 'Enhanced'),
  ];

  it('prefers premium, then enhanced, and avoids novelty voices', () => {
    assert.equal(pickVoice(voices, 'en-US')?.identifier, 'com.apple.voice.premium.en-US.Zoe');
    assert.equal(pickVoice(voices.slice(0, 2), 'en-US')?.identifier, 'com.apple.voice.enhanced.en-GB.Daniel');
  });

  it('matches the language prefix and returns null when nothing fits', () => {
    const notUS = voices.filter((v) => v.language !== 'en-US');
    assert.equal(pickVoice(notUS, 'en-US')?.identifier, 'com.apple.voice.enhanced.en-GB.Daniel');
    assert.equal(pickVoice(voices, 'ja-JP'), null);
  });
});

describe('loadVoices', () => {
  it('returns the voices', async () => {
    const voices = [voice('a', 'Default')];
    assert.deepEqual(await loadVoices(async () => voices), voices);
  });

  it('falls back to [] when the call rejects or throws', async () => {
    assert.deepEqual(await loadVoices(() => Promise.reject(new Error('no voices'))), []);
    assert.deepEqual(
      await loadVoices(() => {
        throw new Error('UnavailabilityError');
      }),
      [],
    );
  });
});

describe('prepareTtsAudioSession', () => {
  const snapshot: AudioSessionSnapshot = {
    category: 'playAndRecord',
    categoryOptions: ['allowBluetooth', 'defaultToSpeaker'],
    mode: 'default',
  };

  function fakeModule(failing?: 'setCategoryIOS') {
    const calls: unknown[][] = [];
    const module: AudioSessionModule = {
      setCategoryIOS: (options) => {
        calls.push(['setCategoryIOS', options]);
        if (failing === 'setCategoryIOS') throw new Error('OSStatus -50');
      },
      setAudioSessionActiveIOS: (value) => {
        calls.push(['setAudioSessionActiveIOS', value]);
      },
      getAudioSessionCategoryAndOptionsIOS: () => {
        calls.push(['getAudioSessionCategoryAndOptionsIOS']);
        return snapshot;
      },
    };
    return { module, calls };
  }

  it('does nothing without the native module (Expo Go)', () => {
    assert.deepEqual(prepareTtsAudioSession(null), { audioSession: null, audioSessionError: null });
  });

  it('sets playAndRecord + defaultToSpeaker, activates, then records the session', () => {
    const { module, calls } = fakeModule();
    const result = prepareTtsAudioSession(module);
    assert.deepEqual(calls, [
      [
        'setCategoryIOS',
        {
          category: 'playAndRecord',
          categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
          mode: 'default',
        },
      ],
      ['setAudioSessionActiveIOS', true],
      ['getAudioSessionCategoryAndOptionsIOS'],
    ]);
    assert.equal(calls[0][1], TTS_AUDIO_CATEGORY);
    assert.deepEqual(result, { audioSession: snapshot, audioSessionError: null });
  });

  it('with keepMatching, reads first and skips setCategoryIOS when the session matches', () => {
    const { module, calls } = fakeModule();
    const result = prepareTtsAudioSession(module, { keepMatching: true });
    assert.deepEqual(calls, [['getAudioSessionCategoryAndOptionsIOS'], ['setAudioSessionActiveIOS', true]]);
    assert.equal(result.categoryKept, true);
    assert.deepEqual(result.audioSession, snapshot);
  });

  it('with keepMatching, still sets a session that does not match (the recognizer default mode)', () => {
    const { module, calls } = fakeModule();
    const measurement: AudioSessionSnapshot = { ...snapshot, mode: 'measurement' };
    module.getAudioSessionCategoryAndOptionsIOS = () => {
      calls.push(['getAudioSessionCategoryAndOptionsIOS']);
      return measurement;
    };
    const result = prepareTtsAudioSession(module, { keepMatching: true });
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['getAudioSessionCategoryAndOptionsIOS', 'setCategoryIOS', 'setAudioSessionActiveIOS', 'getAudioSessionCategoryAndOptionsIOS'],
    );
    assert.equal(result.categoryKept, false);
  });

  it('with knownMatching, only activates the session', () => {
    const { module, calls } = fakeModule();
    const result = prepareTtsAudioSession(module, { keepMatching: true, knownMatching: true });
    assert.deepEqual(calls, [['setAudioSessionActiveIOS', true]]);
    assert.equal(result.categoryKept, true);
    assert.equal(result.audioSession, null);
  });

  it('times each native call when given a clock', () => {
    const { module } = fakeModule();
    let t = 0;
    const result = prepareTtsAudioSession(module, { keepMatching: true, now: () => (t += 5) });
    assert.deepEqual(result.timingsMs, { getAudioSessionCategoryAndOptionsIOS: 5, setAudioSessionActiveIOS: 5 });
  });

  it('records a failing step and still reads the session back', () => {
    const { module, calls } = fakeModule('setCategoryIOS');
    const result = prepareTtsAudioSession(module);
    assert.equal(calls.length, 3);
    assert.deepEqual(result, {
      audioSession: snapshot,
      audioSessionError: 'setCategoryIOS: OSStatus -50',
    });
  });
});
