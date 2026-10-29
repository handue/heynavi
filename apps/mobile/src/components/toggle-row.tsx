import { Pressable, StyleSheet, Switch } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, minTouchTarget, spacing } from '@/theme/tokens';

type Props = {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityHint?: string;
};

/** The whole row is the touch target and the one VoiceOver element (a switch). */
export function ToggleRow({ label, value, onValueChange, accessibilityHint }: Props) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={styles.row}>
      <AppText style={styles.label}>{label}</AppText>
      {/* Hidden from accessibility: the row above already is the switch. */}
      <Switch
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: colors.primary, false: colors.border }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: minTouchTarget,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  label: {
    flex: 1,
  },
});
