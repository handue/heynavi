import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { spacing } from '@/theme/tokens';

type Props = {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'success';
};

/** A "label: value" line, read by VoiceOver as one element. */
export function Field({ label, value, tone = 'default' }: Props) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.row}>
      <AppText tone="secondary">{label}</AppText>
      <AppText variant="bodyStrong" tone={tone} style={styles.value}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.sm,
  },
  value: {
    flexShrink: 1,
  },
});
