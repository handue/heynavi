/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS, cleanApiUrl, normalizeSettings } from './settings-schema.ts';

describe('settings', () => {
  it('fills defaults and drops invalid values', () => {
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings({ speechSpeed: 'warp', verbosity: 'loud', autoUpdates: 'no', onboarded: 1 }), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings({ speechSpeed: 'faster', verbosity: 'quiet', autoUpdates: false, onboarded: true }), {
      ...DEFAULT_SETTINGS,
      speechSpeed: 'faster',
      verbosity: 'quiet',
      autoUpdates: false,
      onboarded: true,
    });
  });

  it('accepts only plain http(s) backend URLs', () => {
    assert.equal(cleanApiUrl('https://abc-def.trycloudflare.com/'), 'https://abc-def.trycloudflare.com');
    assert.equal(cleanApiUrl('http://192.168.1.23:8000'), 'http://192.168.1.23:8000');
    for (const bad of ['javascript:alert(1)', 'ftp://x.y', 'https://x.y?token=1', 'https://', 42, null]) {
      assert.equal(cleanApiUrl(bad), null, String(bad));
    }
  });
});
