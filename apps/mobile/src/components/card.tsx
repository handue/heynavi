import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

export function Card({ title, subtitle, children }: Props) {
  return (
    // collapsable={false} keeps this a real native view, so a CameraView inside never gets
    // re-parented by view flattening when siblings change.
    <View style={styles.card} collapsable={false}>
      <AppText variant="headline" accessibilityRole="header">
        {title}
      </AppText>
      {subtitle ? <AppText tone="secondary">{subtitle}</AppText> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
});
