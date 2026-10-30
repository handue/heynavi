import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import type { Caption } from '@/session/use-camera-session';
import { colors, iconSize, radii, spacing } from '@/theme/tokens';

type Look = { title: string; icon: Parameters<typeof Icon>[0]['name']; color: string; badge: string };

/** White cards (wireframes 03 and 04): what the user asked for, and possible obstacles. */
const CARD: Partial<Record<Caption['kind'], Look>> = {
  description: { title: 'Scene description', icon: 'waveform', color: colors.primary, badge: colors.lightBlue },
  answer: { title: 'Answer', icon: 'text.bubble.fill', color: colors.primary, badge: colors.lightBlue },
  obstacle: { title: 'Potential obstacle', icon: 'exclamationmark.triangle.fill', color: colors.hazardOnLight, badge: 'rgba(255, 59, 48, 0.12)' },
  maybe: { title: 'Not confirmed', icon: 'questionmark.circle.fill', color: '#A15C00', badge: 'rgba(255, 149, 0, 0.16)' },
};

/** How long a card stays after HeyNavi finishes saying it. */
const HOLD_MS = { card: 9000, bubble: 5000 };

/**
 * The line HeyNavi is saying or just said, over the bottom of the camera. Descriptions, answers
 * and possible obstacles get a white card with a small icon and a title (wireframes 03 and 04);
 * automatic updates and status lines a compact dark bubble (wireframe 02). Cards appear with the
 * speech and leave a few seconds after it, so the camera stays clear; with VoiceOver on they stay,
 * so the last line can be read again. Static text, not a live region: the app already spoke it.
 */
export function CaptionCard({ caption, speaking }: { caption: Caption | null; speaking: boolean }) {
  const visible = useContextualVisibility(caption, speaking);
  if (!caption || !visible) return null;
  const look = CARD[caption.kind];
  // The title already says "Potential obstacle"; the spoken prefix is not repeated under it.
  const text = caption.kind === 'obstacle' ? capitalize(caption.text.replace(/^Possible obstacles?:\s*/, '')) : caption.text;

  return (
    // Not keyed by the line: a new line replaces the text in place (a cross-fade would overlap
    // two lines); the card only fades in when it appears and out when it leaves.
    <Animated.View entering={FadeInDown.duration(240)} exiting={FadeOut.duration(320)}>
      {look ? (
        <View style={styles.card} accessible accessibilityLabel={`${look.title}: ${caption.text}`}>
          <View style={styles.header}>
            <View style={[styles.badge, { backgroundColor: look.badge }]}>
              <Icon name={look.icon} size={iconSize.sm} color={look.color} />
            </View>
            <AppText variant="subhead" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.title}>
              {look.title}
            </AppText>
            <Icon name="speaker.wave.2.fill" size={iconSize.md} color={speaking ? colors.primary : colors.border} />
          </View>
          <AppText variant="body" numberOfLines={4} maxFontSizeMultiplier={1.5} style={styles.body}>
            {text}
          </AppText>
        </View>
      ) : (
        <View style={styles.bubble} accessible accessibilityLabel={`Last said: ${caption.text}`}>
          <View style={styles.speaker}>
            <Icon name="speaker.wave.2.fill" size={iconSize.sm} color={colors.white} />
          </View>
          <AppText variant="subhead" numberOfLines={3} maxFontSizeMultiplier={1.5} style={styles.bubbleText}>
            {caption.text}
          </AppText>
        </View>
      )}
    </Animated.View>
  );
}

/** Shown while it is spoken and for a while after; always with VoiceOver on. */
function useContextualVisibility(caption: Caption | null, speaking: boolean): boolean {
  const [screenReader, setScreenReader] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    setVisible(true);
    if (!caption || speaking || screenReader) return;
    const timer = setTimeout(() => setVisible(false), CARD[caption.kind] ? HOLD_MS.card : HOLD_MS.bubble);
    return () => clearTimeout(timer);
  }, [caption, speaking, screenReader]);

  return visible;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 4,
    paddingTop: spacing.md + 2,
    paddingBottom: spacing.md + 4,
    borderRadius: radii.card + 2,
    backgroundColor: colors.glassLight,
    boxShadow: '0px 8px 24px 0px rgba(0, 0, 0, 0.22)',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  badge: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: colors.text },
  body: { color: colors.text, fontSize: 16, lineHeight: 22 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.sm + 2,
    paddingRight: spacing.md + 4,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.card + 2,
    backgroundColor: colors.glassDark,
  },
  speaker: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleText: { flex: 1, color: colors.white, fontWeight: '500', lineHeight: 22 },
});
