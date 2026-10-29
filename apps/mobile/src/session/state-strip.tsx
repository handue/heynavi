import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { CONFIRM } from '@/agent/confirm';
import type { ErrorKind } from '@/agent/phrases';
import type { Detection, SearchStatus } from '@/agent/types';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  target: string;
  status: SearchStatus;
  statusLabel: string;
  /** Candidate detections per recent frame, oldest first. */
  window: readonly Detection[][];
  failing: ErrorKind | null;
};

const STATUS_COLOR: Record<SearchStatus, string> = {
  IDLE: colors.textSecondary,
  SEARCHING: colors.primary,
  CONFIRMING: colors.primary,
  FOUND: colors.success,
  GUIDING: colors.success,
  LOST: colors.danger,
  PAUSED: colors.textSecondary,
  CANCELLED: colors.textSecondary,
};

const FAILING_LABEL: Record<ErrorKind, string> = {
  network: 'Server unreachable',
  slow: 'Server slow',
  unauthorized: 'App token rejected',
  notConfigured: 'Server not configured',
  cantAnalyze: 'View rejected',
  server: 'Server error',
  camera: 'Camera error',
};

/**
 * Target, state and a 3-dot confirmation indicator (PLAN wireframe change 2). Deliberately not a
 * live region: the app speaks for itself, and VoiceOver must not talk over it.
 */
export function StateStrip({ target, status, statusLabel, window, failing }: Props) {
  const confirmed = status === 'FOUND' || status === 'GUIDING';
  const recent = window.slice(-CONFIRM.windowSize);
  const dots = Array.from({ length: CONFIRM.windowSize }, (_, i) => {
    if (confirmed) return true;
    const frame = recent[i - (CONFIRM.windowSize - recent.length)];
    return frame != null && frame.length > 0;
  });
  const hits = dots.filter(Boolean).length;

  return (
    <View
      accessible
      accessibilityLabel={`Target: ${target}. Status: ${statusLabel}. ${hits} of ${CONFIRM.windowSize} recent frames matched.${failing ? ` ${FAILING_LABEL[failing]}.` : ''}`}
      style={styles.strip}>
      <View style={styles.target}>
        <AppText variant="caption" tone="secondary">
          Target
        </AppText>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {target}
        </AppText>
      </View>
      <View style={[styles.chip, { backgroundColor: STATUS_COLOR[status] }]}>
        <AppText variant="bodyStrong" tone="inverse">
          {statusLabel}
        </AppText>
      </View>
      <View style={styles.dots}>
        {dots.map((filled, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              filled
                ? { backgroundColor: confirmed ? colors.success : colors.primary, borderColor: 'transparent' }
                : null,
            ]}
          />
        ))}
      </View>
      {failing ? (
        <AppText variant="caption" tone="danger" style={styles.failing}>
          {FAILING_LABEL[failing]}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  target: {
    flexShrink: 1,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.chip,
  },
  dots: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  failing: {
    width: '100%',
  },
});
