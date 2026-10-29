import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { CONFIRM, meets } from '@/agent/confirm';
import type { Detection } from '@/agent/types';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  detections: readonly Detection[];
  label: string;
  /** Preview size in points. Captures are not cropped (9:16 both), so boxes map 1:1. */
  width: number;
  height: number;
};

/** SAM boxes on top of the preview. Visual only: hidden from VoiceOver, never touchable. */
export function DetectionOverlay({ detections, label, width, height }: Props) {
  if (width === 0 || height === 0) return null;
  return (
    <View
      style={styles.layer}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {detections.map((d, i) => {
        const [x1, y1, x2, y2] = d.box;
        const candidate = meets(d, CONFIRM.tauDetect);
        return (
          <View
            key={i}
            style={[
              styles.box,
              candidate ? styles.candidate : styles.weak,
              {
                left: x1 * width,
                top: y1 * height,
                width: Math.max(0, x2 - x1) * width,
                height: Math.max(0, y2 - y1) * height,
              },
            ]}>
            <View style={[styles.tag, candidate ? styles.tagCandidate : styles.tagWeak]}>
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
  tagWeak: {
    backgroundColor: colors.scrim,
  },
});
