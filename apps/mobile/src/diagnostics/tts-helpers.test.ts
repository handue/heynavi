/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Voice, VoiceQuality } from 'expo-speech';

import {
  TTS_AUDIO_CATEGORY,
  isPremiumVoice,
  loadVoices,
  prepareTtsAudioSession,
  voiceQualityLabel,
  type AudioSessionModule,
  type AudioSessionSnapshot,
} from './tts-helpers.ts';

function voice(identifier: string, quality: 'Default' | 'Enhanced'): Voice {
  return { identifier, name: identifier, language: 'en-US', quality: quality as VoiceQuality };
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
