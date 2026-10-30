import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, radii, spacing } from '@/theme/tokens';

export type Segment<T extends string> = { value: T; label: string; accessibilityLabel?: string };

type Props<T extends string> = {
  /** Read by VoiceOver before each option ("Speech speed: Normal, selected"). */
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
};

/**
 * A compact iOS-style segmented control. Each segment is a button that reports its selected
 * state, so VoiceOver users hear the choice and can change it with one double tap.
 */
export function Segmented<T extends string>({ label, segments, value, onChange }: Props<T>) {
  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${segment.accessibilityLabel ?? segment.label}`}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => onChange(segment.value)}
            style={[styles.segment, selected && styles.selected]}>
            <AppText variant="subhead" tone={selected ? 'primary' : 'secondary'} numberOfLines={1} maxFontSizeMultiplier={1.6}>
              {segment.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    borderRadius: radii.chip,
    backgroundColor: colors.canvas,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.chip - 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: {
    backgroundColor: colors.white,
    shadowColor: '#1C1E21',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
});
