import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { CONFIRM, meets } from '@/agent/confirm';
import type { Detection } from '@/agent/types';
import { colors, radii, spacing } from '@/theme/tokens';

/** One SAM box and what it is ("chair"). `obstacle` marks a confirmed possible obstacle. */
export type OverlayBox = { key: string; label: string; detection: Detection; obstacle?: boolean };

type Props = {
  boxes: readonly OverlayBox[];
  /** Preview size in points. Captures are not cropped (9:16 both), so boxes map 1:1. */
  width: number;
  height: number;
};

/**
 * SAM boxes on top of the preview: the search target while searching, and every object SAM
 * confirmed while observing. For debugging and the demo; voice stays the interface. Visual
 * only: hidden from VoiceOver, never touchable.
 */
export function DetectionOverlay({ boxes, width, height }: Props) {
  if (width === 0 || height === 0) return null;
  return (
    <View
      style={styles.layer}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {boxes.map(({ key, label, detection: d, obstacle }) => {
        const [x1, y1, x2, y2] = d.box;
        const candidate = meets(d, CONFIRM.tauDetect);
        return (
          <View
            key={key}
            style={[
              styles.box,
              candidate ? (obstacle ? styles.obstacle : styles.candidate) : styles.weak,
              {
                left: x1 * width,
                top: y1 * height,
                width: Math.max(0, x2 - x1) * width,
                height: Math.max(0, y2 - y1) * height,
              },
            ]}>
            <View style={[styles.tag, candidate ? (obstacle ? styles.tagObstacle : styles.tagCandidate) : styles.tagWeak]}>
              <AppText variant="caption" tone="inverse" numberOfLines={1}>
                {label} {d.confidence == null ? '–' : d.confidence.toFixed(2)}
              </AppText>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'none',
  },
  box: {
    position: 'absolute',
    borderWidth: 3,
    borderRadius: radii.chip / 2,
  },
  candidate: {
    borderColor: colors.primary,
  },
  obstacle: {
    borderColor: colors.primary,
    borderWidth: 5,
  },
  weak: {
    borderColor: colors.white,
    borderStyle: 'dashed',
  },
  tag: {
    position: 'absolute',
    left: -3,
    top: -3,
    paddingHorizontal: spacing.xs,
    borderTopLeftRadius: radii.chip / 2,
    borderBottomRightRadius: radii.chip / 2,
  },
  tagCandidate: {
    backgroundColor: colors.primary,
  },
  tagObstacle: {
    backgroundColor: colors.danger,
  },
  tagWeak: {
    backgroundColor: colors.scrim,
  },
});
