import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, minTouchTarget, radii, spacing } from '@/theme/tokens';

export type Choice<T extends string | number> = {
  value: T;
  label: string;
  accessibilityLabel?: string;
};

type Props<T extends string | number> = {
  /** Spoken group name, e.g. "Recognition language". */
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
};

/** A row of mutually exclusive options. Each option reports its selected state to VoiceOver. */
export function ChoiceGroup<T extends string | number>({
  label,
  choices,
  value,
  onChange,
  disabled = false,
}: Props<T>) {
  return (
    <View style={styles.row}>
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Pressable
            key={String(choice.value)}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${choice.accessibilityLabel ?? choice.label}`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(choice.value)}
            style={[
              styles.option,
              selected ? styles.selected : styles.unselected,
              disabled && styles.disabled,
            ]}>
            <AppText variant="bodyStrong" tone={selected ? 'inverse' : 'primary'}>
              {choice.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
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
  selected: {
    backgroundColor: colors.primary,
  },
  unselected: {
    backgroundColor: colors.white,
  },
  disabled: {
    opacity: 0.5,
  },
});
