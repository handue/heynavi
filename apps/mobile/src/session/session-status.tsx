import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { scenePhrases } from '@/scene/scene-phrases';
import type { Verbosity } from '@/scene/types';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  /** What observing is doing; null while a search runs (the search strip shows its state). */
  state: 'observing' | 'paused' | 'starting' | null;
  verbosity: Verbosity;
  /** The last line HeyNavi spoke, so low-vision users and sighted helpers can read it too. */
  lastSaid: string | null;
};

/**
 * Session status and the last spoken line: no object lists or pickers, just what HeyNavi is doing
 * and what it said. Static text, not a live region: the app speaks for itself, and VoiceOver
 * must not talk over it.
 */
export function SessionStatus({ state, verbosity, lastSaid }: Props) {
  const ui = scenePhrases.ui;
  const label = state === 'observing' ? ui.observing : state === 'paused' ? ui.paused : ui.starting;
  return (
    <View style={styles.status}>
      {state ? (
        <View style={styles.header} accessible accessibilityLabel={`${label}. ${ui.verbosity(verbosity)}.`}>
          <View style={[styles.chip, { backgroundColor: state === 'observing' ? colors.primary : colors.textSecondary }]}>
            <AppText variant="bodyStrong" tone="inverse">
              {label}
            </AppText>
          </View>
          <AppText variant="caption" tone="secondary">
            {ui.verbosity(verbosity)}
          </AppText>
        </View>
      ) : null}
      {lastSaid ? (
        <View style={styles.caption} accessible accessibilityLabel={`${ui.lastSaid}: ${lastSaid}`}>
          <AppText variant="caption" tone="secondary">
            {ui.lastSaid}
          </AppText>
          <AppText variant="body" numberOfLines={3}>
            {lastSaid}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  status: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.chip,
  },
  caption: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radii.chip,
    backgroundColor: colors.lightBlue,
  },
});
