import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import type { NavigationSnapshot } from '@/navigation/navigation-controller';
import type { Maneuver } from '@/navigation/route';
import { routePhrases } from '@/navigation/route-phrases';
import { colors, iconSize, radii, spacing } from '@/theme/tokens';

type IconName = Parameters<typeof Icon>[0]['name'];

const MANEUVER_ICON: Record<Maneuver, IconName> = {
  left: 'arrow.turn.up.left',
  right: 'arrow.turn.up.right',
  'slight-left': 'arrow.up.left',
  'slight-right': 'arrow.up.right',
  'sharp-left': 'arrow.turn.up.left',
  'sharp-right': 'arrow.turn.up.right',
  'u-turn': 'arrow.uturn.down',
  straight: 'arrow.up',
  arrive: 'mappin.and.ellipse',
};

/**
 * The route card (ARCHITECTURE 8, 3.3): while a walking route is prepared or followed, the next
 * step from the map and what is left, above the caption. Everything on it is also spoken; the
 * card is for low-vision users, sighted companions and the demo. A close button ends the route.
 */
export function RouteCard({ nav, onClose }: { nav: NavigationSnapshot; onClose: () => void }) {
  if (nav.status === 'idle') return null;
  const ui = routePhrases.ui;
  const place = nav.destination ?? '';
  let icon: IconName = 'figure.walk';
  let title: string;
  let detail: string | null = null;
  switch (nav.status) {
    case 'locating':
      icon = 'location.fill';
      title = ui.locating;
      detail = place;
      break;
    case 'searching':
      icon = 'magnifyingglass';
      title = ui.searching(place);
      break;
    case 'routing':
      title = ui.routing;
      detail = place;
      break;
    case 'rerouting':
      title = ui.rerouting;
      detail = place;
      break;
    case 'arrived':
      icon = 'mappin.and.ellipse';
      title = ui.arrived(place);
      detail = ui.fromMap;
      break;
    case 'navigating':
      icon = nav.next ? MANEUVER_ICON[nav.next.maneuver] : 'figure.walk';
      title = nav.next?.instruction ?? place;
      detail = [nav.next?.inM != null ? ui.inAbout(nav.next.inM) : null, nav.leftM != null ? ui.left(nav.leftM, place) : place]
        .filter(Boolean)
        .join(' · ');
      break;
  }
  const weak = nav.gpsWeak && nav.status === 'navigating';

  return (
    <Animated.View entering={FadeInDown.duration(240)} exiting={FadeOut.duration(280)} style={styles.card}>
      <View style={styles.badge}>
        <Icon name={icon} size={iconSize.lg} color={colors.white} />
      </View>
      <View style={styles.text} accessible accessibilityLabel={[title, detail, weak ? ui.weakGps : null].filter(Boolean).join('. ')}>
        <AppText variant="subhead" numberOfLines={2} maxFontSizeMultiplier={1.4} style={styles.title}>
          {title}
        </AppText>
        {detail ? (
          <AppText variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.detail}>
            {detail}
          </AppText>
        ) : null}
        {weak ? (
          <View style={styles.weak}>
            <Icon name="location.slash.fill" size={iconSize.sm} color="#A15C00" />
            <AppText variant="caption" maxFontSizeMultiplier={1.3} style={styles.weakText}>
              {ui.weakGps}
            </AppText>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ui.closeButton}
        accessibilityHint={ui.closeHint}
        onPress={onClose}
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Icon name="xmark" size={iconSize.sm} color={colors.textSecondary} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.card + 2,
    backgroundColor: colors.glassLight,
    boxShadow: '0px 8px 24px 0px rgba(0, 0, 0, 0.22)',
  },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 17, lineHeight: 22 },
  detail: { color: colors.textSecondary, fontSize: 14, lineHeight: 19 },
  weak: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  weakText: { color: '#A15C00', fontSize: 13, lineHeight: 17, fontWeight: '600' },
  close: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(28, 30, 33, 0.06)',
  },
  pressed: { opacity: 0.6 },
});
