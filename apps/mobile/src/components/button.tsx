import { Pressable, StyleSheet } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, minTouchTarget, radii, spacing } from '@/theme/tokens';

type Variant = 'primary' | 'secondary' | 'danger';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  large?: boolean;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  large = false,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        large && styles.large,
        disabled ? styles.disabled : variantStyles[variant],
        pressed && !disabled && styles.pressed,
      ]}>
      <AppText
        variant={large ? 'headline' : 'bodyStrong'}
        tone={disabled ? 'secondary' : variant === 'secondary' ? 'primary' : 'inverse'}
        style={styles.label}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget,
    borderRadius: radii.button,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  large: {
    minHeight: 72,
    paddingVertical: spacing.lg,
  },
  disabled: {
    backgroundColor: colors.disabledFill,
    borderColor: colors.disabledFill,
  },
  pressed: {
    opacity: 0.8,
  },
  label: {
    textAlign: 'center',
  },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  secondary: { backgroundColor: colors.white, borderColor: colors.primary },
  danger: { backgroundColor: colors.danger, borderColor: colors.danger },
});
