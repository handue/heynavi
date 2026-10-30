import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import { colors, iconSize, radii, shadows, spacing } from '@/theme/tokens';

type IconName = Parameters<typeof Icon>[0]['name'];

/** A titled group of rows on a soft card (iOS inset grouped list). */
export function SettingsGroup({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <AppText variant="caption" tone="secondary" accessibilityRole="header" style={styles.groupTitle}>
        {title.toUpperCase()}
      </AppText>
      <View style={styles.card}>{children}</View>
      {footer ? (
        <AppText variant="caption" tone="secondary" style={styles.footer}>
          {footer}
        </AppText>
      ) : null}
    </View>
  );
}

type RowProps = {
  icon: IconName;
  title: string;
  subtitle?: string;
  /** A control under the title (a segmented control). */
  below?: ReactNode;
  /** Value text on the right, or a switch. */
  value?: string;
  toggle?: { value: boolean; onChange: (value: boolean) => void; hint?: string };
  onPress?: () => void;
  hint?: string;
  last?: boolean;
};

/** One settings row: a tinted icon, a title, and a value, a switch, a chevron or a control below. */
export function SettingsRow({ icon, title, subtitle, below, value, toggle, onPress, hint, last }: RowProps) {
  const content = (
    <>
      <View style={styles.rowTop}>
        <View style={styles.iconTile}>
          <Icon name={icon} size={iconSize.md} color={colors.primary} />
        </View>
        <View style={styles.texts}>
          <AppText variant="subhead">{title}</AppText>
          {subtitle ? (
            <AppText variant="caption" tone="secondary">
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {value ? (
          <AppText variant="caption" tone="secondary" numberOfLines={1} style={styles.value}>
            {value}
          </AppText>
        ) : null}
        {toggle ? (
          <Switch
            value={toggle.value}
            onValueChange={toggle.onChange}
            trackColor={{ true: colors.primary }}
            accessibilityLabel={title}
            accessibilityHint={toggle.hint}
          />
        ) : null}
        {onPress ? <Icon name="chevron.right" size={iconSize.sm} color={colors.textSecondary} /> : null}
      </View>
      {below ? <View style={styles.below}>{below}</View> : null}
    </>
  );
  return (
    <View style={[styles.row, !last && styles.separator]}>
      {onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.6 }}>
          {content}
        </Pressable>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  groupTitle: { paddingHorizontal: spacing.lg, letterSpacing: 0.4 },
  footer: { paddingHorizontal: spacing.lg },
  card: { borderRadius: radii.card, backgroundColor: colors.white, ...shadows.card },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  separator: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.lightBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: { flex: 1, gap: 2 },
  value: { maxWidth: '45%' },
  below: { paddingLeft: 44 },
});
