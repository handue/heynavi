import { useRouter } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { Segmented } from '@/components/segmented';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { apiBaseUrl, buildApiBaseUrl } from '@/config';
import { getSettings, subscribeSettings, updateSettings } from '@/settings/app-settings';
import type { SpeechSpeed } from '@/settings/settings-schema';
import type { Verbosity } from '@/scene/types';
import { colors, spacing } from '@/theme/tokens';

/**
 * Settings (wireframe 07): grouped rows, compact controls, technical options tucked under
 * Advanced. Each of these can also be changed by voice in a session ("quieter", "more detail",
 * "updates off"). Labels avoid command phrases and the wake word: VoiceOver reads them aloud
 * while the session's microphone may still be listening underneath.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const [advanced, setAdvanced] = useState(false);
  const host = hostOf(apiBaseUrl());

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SettingsGroup title="Voice">
        <SettingsRow
          icon="speaker.wave.2.fill"
          title="Speech speed"
          last
          below={
            <Segmented<SpeechSpeed>
              label="Speech speed"
              value={settings.speechSpeed}
              onChange={(speechSpeed) => updateSettings({ speechSpeed })}
              segments={[
                { value: 'slower', label: 'Slower' },
                { value: 'normal', label: 'Normal' },
                { value: 'faster', label: 'Faster' },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Spoken updates"
        footer="Possible obstacles are always mentioned first. Spoken updates never say a way is safe or clear.">
        <SettingsRow
          icon="waveform"
          title="Automatic announcements"
          subtitle="Mention what could be in your way"
          toggle={{
            value: settings.autoUpdates,
            onChange: (autoUpdates) => updateSettings({ autoUpdates }),
            hint: 'When off, you only hear answers to your questions.',
          }}
        />
        <SettingsRow
          icon="slider.horizontal.3"
          title="Announcement frequency"
          last
          below={
            <Segmented<Verbosity>
              label="Announcement frequency"
              value={settings.verbosity}
              onChange={(verbosity) => updateSettings({ verbosity })}
              segments={[
                { value: 'quiet', label: 'Few', accessibilityLabel: 'Few: only things in your way' },
                { value: 'normal', label: 'Normal' },
                { value: 'detailed', label: 'More', accessibilityLabel: 'More: also signs and things off to the side' },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Help">
        <SettingsRow
          icon="play.circle.fill"
          title="Replay the introduction"
          hint="Plays the welcome and the safety notes again."
          last
          onPress={() => {
            updateSettings({ onboarded: false });
            router.push('/onboarding');
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Advanced">
        <SettingsRow
          icon="wrench.and.screwdriver.fill"
          title={advanced ? 'Hide advanced options' : 'Show advanced options'}
          last={!advanced}
          onPress={() => setAdvanced((v) => !v)}
        />
        {advanced ? (
          <>
            <SettingsRow
              icon="server.rack"
              title="Server"
              subtitle={settings.apiUrl ? 'Set by the tunnel script' : 'Built into the app'}
              value={host}
            />
            {settings.apiUrl ? (
              <SettingsRow
                icon="arrow.uturn.backward"
                title="Use the built-in server"
                hint={`Goes back to ${hostOf(buildApiBaseUrl)}.`}
                onPress={() => updateSettings({ apiUrl: null })}
              />
            ) : null}
            <SettingsRow
              icon="speedometer"
              title="Decision panel"
              subtitle="What Spark saw, what SAM checked, and why"
              toggle={{ value: settings.devOverlay, onChange: (devOverlay) => updateSettings({ devOverlay }) }}
            />
            <SettingsRow icon="stethoscope" title="Device diagnostics" last onPress={() => router.push('/diagnostics')} />
          </>
        ) : null}
      </SettingsGroup>
    </ScrollView>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xxl },
});
