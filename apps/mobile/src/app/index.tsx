import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import { Orb } from '@/components/orb';
import { getSettings } from '@/settings/app-settings';
import { colors, iconSize, radii, shadows, spacing } from '@/theme/tokens';

type IconName = Parameters<typeof Icon>[0]['name'];

/** What HeyNavi does, not things to pick: capabilities, introduced. */
const FEATURES: { icon: IconName; title: string; detail: string }[] = [
  { icon: 'exclamationmark.triangle.fill', title: 'Obstacles', detail: 'Announced on their own' },
  { icon: 'eye.fill', title: 'Describe', detail: '“What’s around me?”' },
  { icon: 'questionmark.bubble.fill', title: 'Ask', detail: '“Where is the door?”' },
  { icon: 'magnifyingglass', title: 'Find', detail: '“Find a chair”' },
];

/**
 * Home (wireframe 01): the name and settings, the living orb, the promise, one prominent start,
 * and compact cards that introduce what HeyNavi does. The first start goes through onboarding.
 */
export default function HomeScreen() {
  const router = useRouter();

  function start() {
    router.push(getSettings().onboarded ? '/session' : '/onboarding');
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title" accessibilityRole="header">
            HeyNavi
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => router.push('/settings')}
            hitSlop={8}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
            <Icon name="gearshape" size={iconSize.lg} color={colors.text} />
          </Pressable>
        </View>

        <View style={styles.middle}>
          <View style={styles.hero}>
            {/* The orb fills about 60% of its canvas; the rest is its halo. */}
            <View style={styles.symbol}>
              <Orb size={168} />
            </View>
            <AppText variant="title" style={styles.tagline}>
              See more.{'\n'}Go further.
            </AppText>
            <AppText tone="secondary" style={styles.center}>
              Your AI visual companion{'\n'}for a more independent day.
            </AppText>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start HeyNavi"
            accessibilityHint="Opens the camera. You'll hear about things that could be in your way, and you can ask questions."
            onPress={start}
            style={({ pressed }) => [styles.start, pressed && styles.pressed]}>
            <View style={styles.startIcon}>
              <Icon name="mic.fill" size={iconSize.lg} color={colors.primary} />
            </View>
            <View style={styles.startText}>
              <AppText variant="headline" tone="inverse">
                Start HeyNavi
              </AppText>
              <AppText variant="caption" tone="inverse" style={styles.startSub}>
                Tap, then just talk
              </AppText>
            </View>
            <Icon name="chevron.right" size={iconSize.md} color={colors.white} />
          </Pressable>

          <View style={styles.grid}>
            {FEATURES.map((f) => (
              <View key={f.title} style={styles.feature} accessible accessibilityLabel={`${f.title}. ${f.detail}`}>
                <View style={styles.featureIcon}>
                  <Icon name={f.icon} size={iconSize.md} color={colors.primary} />
                </View>
                <View style={styles.featureText}>
                  <AppText variant="subhead" numberOfLines={1}>
                    {f.title}
                  </AppText>
                  <AppText variant="caption" tone="secondary" numberOfLines={2} style={styles.featureDetail}>
                    {f.detail}
                  </AppText>
                </View>
              </View>
            ))}
          </View>
        </View>

        <AppText variant="caption" tone="secondary" style={styles.center}>
          HeyNavi does not replace a cane, a guide dog or mobility training, and cannot tell whether it is safe to
          walk.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  symbol: { marginVertical: -16 },
  safeArea: { flex: 1, backgroundColor: colors.white },
  content: { flexGrow: 1, justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: spacing.lg },
  middle: { gap: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: spacing.sm },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  hero: { alignItems: 'center', gap: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  tagline: { textAlign: 'center', marginTop: spacing.xs },
  center: { textAlign: 'center' },
  start: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.card + 4,
    backgroundColor: colors.primary,
    ...shadows.raised,
  },
  startIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { flex: 1, gap: 2 },
  startSub: { opacity: 0.9 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  feature: {
    flexBasis: '46%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.chip + 4,
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...shadows.card,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.lightBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: { flex: 1 },
  featureDetail: { fontSize: 13, lineHeight: 17 },
});
