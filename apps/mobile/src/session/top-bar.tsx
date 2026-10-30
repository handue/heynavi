import { Pressable, StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import { colors, iconSize, radii, spacing } from '@/theme/tokens';

export type PillTone = 'listening' | 'speaking' | 'thinking' | 'caution' | 'off' | 'alert';
export type ChipTone = 'observing' | 'paused' | 'searching';

type Props = {
  onClose: () => void;
  onSettings: () => void;
  /**
   * The voice state: `label` is shown ("HeyNavi is listening…"), `spoken` is what VoiceOver reads
   * ("Listening"). The microphone hears VoiceOver, so `spoken` never contains "HeyNavi" or a
   * command.
   */
  pill: { label: string; spoken: string; tone: PillTone };
  /** What HeyNavi is doing: "Observing", "Observing paused", "Searching: chair". */
  chip: { label: string; tone: ChipTone };
};

const PILL_ICON: Record<PillTone, { name: Parameters<typeof Icon>[0]['name']; color: string; live: boolean }> = {
  listening: { name: 'waveform', color: colors.primary, live: true },
  speaking: { name: 'waveform', color: colors.primary, live: true },
  thinking: { name: 'ellipsis', color: colors.primary, live: true },
  caution: { name: 'exclamationmark.triangle.fill', color: colors.hazardOnLight, live: false },
  off: { name: 'mic.slash.fill', color: colors.textSecondary, live: false },
  alert: { name: 'mic.slash.fill', color: colors.hazardOnLight, live: false },
};

const CHIP_DOT: Record<ChipTone, string> = {
  observing: '#22C55E',
  paused: '#9AA3AF',
  searching: colors.primary,
};

/** Height of the bar below the safe-area inset (for keeping box labels clear of it). */
export const TOP_BAR_HEIGHT = 44 + spacing.sm + 28;

/**
 * The bar over the top of the camera (wireframes 02–04): round close and settings buttons on dark
 * glass, a light frosted voice pill between them, and a small status chip below on the right.
 * Static labels, not live regions.
 */
export function TopBar({ onClose, onSettings, pill, chip }: Props) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const icon = PILL_ICON[pill.tone];
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + spacing.xs }]} pointerEvents="box-none">
      <View style={styles.row} pointerEvents="box-none">
        <RoundButton icon="xmark" label="Close" hint="Ends the session and goes back." onPress={onClose} />
        <View style={styles.pill} accessible accessibilityLabel={`Voice status: ${pill.spoken}`}>
          <Icon
            name={icon.name}
            size={iconSize.md}
            color={icon.color}
            animation={
              icon.live && !reduceMotion
                ? { repeating: true, variableAnimationSpec: { iterative: true, reversing: true } }
                : undefined
            }
          />
          <AppText variant="subhead" numberOfLines={1} maxFontSizeMultiplier={1.4} style={styles.pillText}>
            {pill.label}
          </AppText>
        </View>
        <RoundButton icon="gearshape" label="Settings" onPress={onSettings} />
      </View>
      <View style={styles.chip} accessible accessibilityLabel={chip.label}>
        <View style={[styles.dot, { backgroundColor: CHIP_DOT[chip.tone] }]} />
        <AppText variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.chipText}>
          {chip.label}
        </AppText>
      </View>
    </View>
  );
}

function RoundButton(props: { icon: Parameters<typeof Icon>[0]['name']; label: string; hint?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.hint}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}>
      <Icon name={props.icon} size={iconSize.md} color={colors.white} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.glassDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 40,
    paddingHorizontal: spacing.md + 4,
    borderRadius: radii.pill,
    backgroundColor: colors.glassLight,
    boxShadow: '0px 4px 14px 0px rgba(0, 0, 0, 0.18)',
  },
  pillText: { flexShrink: 1, color: colors.text, fontSize: 15 },
  chip: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm + 4,
    borderRadius: radii.pill,
    backgroundColor: colors.glassLight,
    boxShadow: '0px 2px 10px 0px rgba(0, 0, 0, 0.15)',
  },
  chipText: { flexShrink: 1, color: colors.text, fontSize: 13, lineHeight: 17, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
