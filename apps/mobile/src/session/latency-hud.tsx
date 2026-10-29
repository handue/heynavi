import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { formatMs } from '@/lib/stats';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  lastRttMs: number | null;
  p50RttMs: number | null;
  lastSamMs: number | null;
  frames: number;
};

/** Small latency readout on the preview, for the demo and for tuning. */
export function LatencyHud({ lastRttMs, p50RttMs, lastSamMs, frames }: Props) {
  return (
    <View
      style={styles.hud}
      accessible
      accessibilityLabel={`Latency: round trip ${formatMs(lastRttMs)}, median ${formatMs(p50RttMs)}, SAM ${formatMs(lastSamMs)}, ${frames} frames`}>
      <AppText variant="caption" tone="inverse">
        RTT {formatMs(lastRttMs)} · p50 {formatMs(p50RttMs)}
      </AppText>
      <AppText variant="caption" tone="inverse">
        SAM {formatMs(lastSamMs)} · #{frames}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    pointerEvents: 'none',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.chip,
    backgroundColor: colors.scrim,
  },
});
