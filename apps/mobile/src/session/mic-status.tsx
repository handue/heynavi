import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { phrases, type MicStatusLabel } from '@/agent/phrases';
import { colors, spacing } from '@/theme/tokens';

type Props = {
  status: MicStatusLabel;
  /** "Listening", "Mic off", ... */
  label: string;
  /** False once iOS will not prompt again: the button opens Settings instead. */
  canAskAgain: boolean;
  onPress: () => void;
};

const DOT_COLOR: Record<MicStatusLabel, string> = {
  listening: colors.success,
  paused: colors.textSecondary,
  off: colors.textSecondary,
  asking: colors.primary,
  'needs-permission': colors.danger,
  unavailable: colors.textSecondary,
  stopped: colors.danger,
};

/**
 * Microphone state and its one button. The text is static on purpose, not a live region: the
 * app speaks for itself, and VoiceOver must not talk over it (or be heard by the recognizer).
 */
export function MicStatus({ status, label, canAskAgain, onPress }: Props) {
  const ui = phrases('en-US').ui.mic;
  const button = buttonFor(status, canAskAgain, ui);

  return (
    <View style={styles.row}>
      <View style={styles.status} accessible accessibilityLabel={`Microphone: ${label}`}>
        <View style={[styles.dot, { backgroundColor: DOT_COLOR[status] }]} />
        <AppText variant="bodyStrong" style={styles.label}>
          {label}
        </AppText>
      </View>
      {button ? (
        <View style={styles.button}>
          <Button
            variant="secondary"
            label={button.label}
            accessibilityHint={button.hint}
            onPress={onPress}
          />
        </View>
      ) : null}
    </View>
  );
}

function buttonFor(
  status: MicStatusLabel,
  canAskAgain: boolean,
  ui: ReturnType<typeof phrases>['ui']['mic'],
): { label: string; hint: string } | null {
  switch (status) {
    case 'listening':
    case 'asking':
      return { label: ui.turnOff, hint: ui.turnOffHint };
    case 'needs-permission':
      return canAskAgain
        ? { label: ui.allow, hint: ui.allowHint }
        : { label: ui.openSettings, hint: ui.openSettingsHint };
    case 'off':
    case 'paused':
    case 'stopped':
      return { label: ui.turnOn, hint: ui.turnOnHint };
    case 'unavailable':
      return null;
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
    minHeight: 44,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  label: {
    flexShrink: 1,
  },
  button: {
    flexGrow: 1,
  },
});
