import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, minTouchTarget, radii, spacing } from '@/theme/tokens';

export type RadioOption<T extends string> = {
  value: T;
  label: string;
  /** BCP 47 language of the label, so VoiceOver reads it with the right voice. */
  lang?: string;
};

type Props<T extends string> = {
  /** Spoken group name, e.g. "Object to find". */
  label: string;
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** One horizontally scrolling row instead of wrapping lines. */
  scroll?: boolean;
};

/** Mutually exclusive options exposed to VoiceOver as a radio group. */
export function RadioGroup<T extends string>({ label, options, value, onChange, scroll = false }: Props<T>) {
  const items = options.map((option) => {
    const checked = option.value === value;
    return (
      <Pressable
        key={option.value}
        accessibilityRole="radio"
        accessibilityLabel={option.label}
        accessibilityLanguage={option.lang}
        accessibilityState={{ checked }}
        onPress={() => onChange(option.value)}
        style={({ pressed }) => [
          styles.option,
          checked ? styles.checked : styles.unchecked,
          pressed && styles.pressed,
        ]}>
        <AppText variant="bodyStrong" tone={checked ? 'inverse' : 'primary'}>
          {option.label}
        </AppText>
      </Pressable>
    );
  });

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {items}
        </ScrollView>
      ) : (
        <View style={[styles.row, styles.wrap]}>{items}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  wrap: {
    flexWrap: 'wrap',
  },
  option: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.chip,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checked: {
    backgroundColor: colors.primary,
  },
  unchecked: {
    backgroundColor: colors.white,
  },
  pressed: {
    opacity: 0.8,
  },
});
