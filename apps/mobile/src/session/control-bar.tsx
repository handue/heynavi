import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import { colors, iconSize, radii, spacing } from '@/theme/tokens';

type Control = {
  icon?: Parameters<typeof Icon>[0]['name'];
  /** Short visible caption under the button ("Pause"). */
  caption: string;
  /** What VoiceOver reads ("Pause observing"); never a voice command, since the mic hears it. */
  label: string;
  hint?: string;
  disabled?: boolean;
  onPress: () => void;
};

type Props = { left: Control; center: Control & { content: ReactNode }; right: Control };

/** The center button's diameter. */
export const CENTER_SIZE = 84;
/**
 * The HeyNavi symbol's canvas in the center button, larger than the button: the orb then fills
 * about three quarters of the white disc, and its halo spills past the edge into the button's glow.
 */
export const CENTER_SYMBOL_SIZE = 108;
const SIDE_SIZE = 56;
const CAPTION_HEIGHT = 18;

/** Height of the controls (for placing the caption card above them). */
export const CONTROL_BAR_HEIGHT = CENTER_SIZE + spacing.sm + CAPTION_HEIGHT;

/**
 * The camera controls (wireframe 02): round buttons floating over the bottom of the live view,
 * with the living HeyNavi symbol in the middle as the "Describe the view" button. No panel behind
 * them; the screen adds a soft gradient for contrast. Voice does everything too; this is the touch
 * way. Targets are 56 pt (sides) and 84 pt (center); all captions share one baseline.
 */
export function ControlBar({ left, center, right }: Props) {
  return (
    <View style={styles.row}>
      <Side {...left} />
      <View style={styles.slot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={center.label}
          accessibilityHint={center.hint}
          accessibilityState={{ disabled: center.disabled }}
          disabled={center.disabled}
          onPress={center.onPress}
          style={({ pressed }) => [styles.center, center.disabled && styles.disabled, pressed && styles.pressed]}>
          {center.content}
        </Pressable>
        <Caption text={center.caption} />
      </View>
      <Side {...right} />
    </View>
  );
}

function Side({ icon, caption, label, hint, disabled, onPress }: Control) {
  return (
    <View style={styles.slot}>
      <View style={styles.frame}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={hint}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          hitSlop={8}
          style={({ pressed }) => [styles.side, disabled && styles.disabled, pressed && styles.pressed]}>
          {icon ? <Icon name={icon} size={iconSize.lg} color={colors.white} /> : null}
        </Pressable>
      </View>
      <Caption text={caption} />
    </View>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <AppText variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.caption}>
      {text}
    </AppText>
  );
}

const styles = StyleSheet.create({
  row: {
    height: CONTROL_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  slot: { width: 96, alignItems: 'center', gap: spacing.sm },
  /** As tall as the center button, so all three captions share a baseline. */
  frame: { height: CENTER_SIZE, justifyContent: 'center' },
  side: {
    width: SIDE_SIZE,
    height: SIDE_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.glassDark,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    width: CENTER_SIZE,
    height: CENTER_SIZE,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 0px 0px 5px rgba(255, 255, 255, 0.3), 0px 0px 24px 6px rgba(6, 104, 225, 0.6)',
  },
  caption: {
    height: CAPTION_HEIGHT,
    color: colors.white,
    fontSize: 13,
    lineHeight: CAPTION_HEIGHT,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
