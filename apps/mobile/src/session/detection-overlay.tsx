import { useEffect } from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import { CONFIRM, meets } from '@/agent/confirm';
import type { Detection } from '@/agent/types';
import { IDENTITY, PORTRAIT_FOV, shiftForRotation, type Quaternion } from '@/perception/motion';
import { colors } from '@/theme/tokens';

/** One SAM box and what it is ("chair"). `obstacle` marks a confirmed possible obstacle. */
export type OverlayBox = { key: string; label: string; detection: Detection; obstacle?: boolean };

type Props = {
  boxes: readonly OverlayBox[];
  /** Preview size in points. Captures are not cropped (9:16 both), so boxes map 1:1. */
  width: number;
  height: number;
  /** Labels stay below this y (the top bar) and above `safeBottom` (the caption). */
  safeTop: number;
  safeBottom: number;
  /**
   * The part of the view that is on screen, in its own x coordinates: the camera view is 9:16 and
   * can be wider than the screen, so labels are kept inside [visibleLeft, visibleRight].
   */
  visibleLeft?: number;
  visibleRight?: number;
  /** Developer overlay: confidence next to each label. */
  showConfidence?: boolean;
  /** How the phone has turned since the boxes' frame was taken; boxes move to follow it. */
  turn?: SharedValue<Quaternion>;
};

const TAG_HEIGHT = 26;
const TAG_GAP = 6;
const EDGE = 6;
const RADIUS = 12;
const ANCHOR = 9;
/** Where the outline's rounded corner passes, measured from the box corner (for the anchor dots). */
const CORNER_INSET = (RADIUS - 1) * (1 - Math.SQRT1_2) + 1 - ANCHOR / 2;
const MOVE_MS = 280;

type Placement = {
  key: string;
  text: string;
  obstacle: boolean;
  strong: boolean;
  box: { left: number; top: number; width: number; height: number };
  tag: { left: number; top: number; maxWidth: number } | null;
};

/**
 * SAM boxes over the camera (wireframes 02–04): the search target while searching, and every
 * walking-relevant object SAM confirmed while observing. Meta-blue rounded outlines with a soft
 * glow, small anchor dots on the corners, and a floating name tag above each box; a possible
 * obstacle in red with an alert icon. Every box is a real SAM detection: nothing is drawn that the
 * models did not return, and no zones, paths or distances are implied.
 *
 * Boxes fade in, glide to their new place when the same object is found again, and fade out when
 * it is gone. They describe a frame a few seconds old, so the layer dims as it ages. Labels stay
 * inside the visible view, clear of the top bar, the caption and each other. Hidden from
 * VoiceOver (HeyNavi says what it sees), never touchable.
 */
export function DetectionOverlay({ boxes, width, height, safeTop, safeBottom, visibleLeft = 0, visibleRight, showConfidence, turn }: Props) {
  const right = visibleRight ?? width;
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  // A box shows where something was when its frame was taken, seconds ago. Turning the phone is
  // corrected (`turn`), walking is not: boxes dim as they age. The next reply brings them back.
  useEffect(() => {
    opacity.value = 1;
    opacity.value = reduceMotion ? 0.85 : withDelay(3500, withTiming(0.25, { duration: 3000 }));
  }, [boxes, opacity, reduceMotion]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (width === 0 || height === 0 || boxes.length === 0) return null;
  const placements = place(boxes, { width, height, safeTop, safeBottom, visibleLeft, right, showConfidence: showConfidence === true });
  return (
    <Animated.View style={[styles.layer, fade]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {placements.map((placement) => (
        <BoxView
          key={placement.key}
          placement={placement}
          animate={!reduceMotion}
          view={{ width, height, safeTop, safeBottom }}
          turn={turn}
        />
      ))}
    </Animated.View>
  );
}

function place(
  boxes: readonly OverlayBox[],
  view: { width: number; height: number; safeTop: number; safeBottom: number; visibleLeft: number; right: number; showConfidence: boolean },
): Placement[] {
  const { width, height, safeTop, safeBottom, visibleLeft, right } = view;
  const fontScale = Math.min(1.2, PixelRatio.getFontScale());
  const maxTagWidth = (right - visibleLeft) * 0.6;
  // Tags already placed, so the next one never lands on top of them.
  const placed: { x: number; y: number; w: number }[] = [];
  return boxes.map(({ key, label, detection: d, obstacle = false }) => {
    const [x1, y1, x2, y2] = d.box;
    const left = Math.max(0, x1 * width);
    const top = Math.max(0, y1 * height);
    const boxWidth = Math.max(12, Math.min(width, x2 * width) - left);
    const boxHeight = Math.max(12, Math.min(height, y2 * height) - top);

    const text = `${capitalize(label)}${view.showConfidence && d.confidence != null ? ` ${d.confidence.toFixed(2)}` : ''}`;
    // Estimated for placement only (the tag sizes to its text): 14 pt semibold, Dynamic Type up to 1.2x.
    const tagWidth = Math.min(maxTagWidth, 24 + text.length * 8.4 * fontScale + (obstacle ? 22 : 0));
    // Over the box's top left corner, or its top right when the box is on the right.
    const anchorRight = x1 > 0.55;
    const preferred = anchorRight ? left + boxWidth - tagWidth : left;
    const tagX = Math.min(Math.max(preferred, visibleLeft + EDGE), right - EDGE - tagWidth);
    // Above the box; just inside its top edge when the top bar is in the way; never below the
    // caption's top; below the box when another tag is already there. No room: box only.
    const clamp = (y: number) => Math.min(Math.max(y, safeTop), safeBottom - TAG_HEIGHT);
    const overlaps = (y: number) => placed.some((p) => Math.abs(p.y - y) < TAG_HEIGHT && tagX < p.x + p.w && p.x < tagX + tagWidth);
    const above = top - TAG_HEIGHT - TAG_GAP;
    let tagTop = clamp(above < safeTop ? top + TAG_GAP : above);
    if (overlaps(tagTop)) tagTop = clamp(top + boxHeight + TAG_GAP);
    const showTag = !overlaps(tagTop) && safeBottom - TAG_HEIGHT > safeTop;
    if (showTag) placed.push({ x: tagX, y: tagTop, w: tagWidth });

    return {
      key,
      text,
      obstacle,
      strong: meets(d, CONFIRM.tauDetect),
      box: { left, top, width: boxWidth, height: boxHeight },
      tag: showTag ? { left: tagX, top: tagTop, maxWidth: maxTagWidth } : null,
    };
  });
}

function BoxView({
  placement,
  animate,
  view,
  turn,
}: {
  placement: Placement;
  animate: boolean;
  view: { width: number; height: number; safeTop: number; safeBottom: number };
  turn?: SharedValue<Quaternion>;
}) {
  const { box, tag, obstacle, strong, text } = placement;
  const color = obstacle ? colors.hazard : colors.detection;
  const x = useSharedValue(box.left);
  const y = useSharedValue(box.top);
  const w = useSharedValue(box.width);
  const h = useSharedValue(box.height);
  const tagX = useSharedValue(tag?.left ?? 0);
  const tagY = useSharedValue(tag?.top ?? 0);

  // The same object found again: glide there instead of jumping.
  const tagLeft = tag?.left;
  const tagTop = tag?.top;
  useEffect(() => {
    const to = (value: number) => (animate ? withTiming(value, { duration: MOVE_MS }) : value);
    x.value = to(box.left);
    y.value = to(box.top);
    w.value = to(box.width);
    h.value = to(box.height);
    if (tagLeft != null && tagTop != null) {
      tagX.value = to(tagLeft);
      tagY.value = to(tagTop);
    }
  }, [animate, box.left, box.top, box.width, box.height, tagLeft, tagTop, x, y, w, h, tagX, tagY]);

  // Where the box's center moved since its frame, as the phone turned.
  const { width: viewWidth, height: viewHeight, safeTop, safeBottom } = view;
  const shift = () => {
    'worklet';
    const center = { u: (x.value + w.value / 2) / viewWidth, v: (y.value + h.value / 2) / viewHeight };
    return shiftForRotation(turn?.value ?? IDENTITY, center.u, center.v, PORTRAIT_FOV);
  };
  const boxStyle = useAnimatedStyle(() => {
    const { du, dv, visible } = shift();
    return {
      left: x.value + du * viewWidth,
      top: y.value + dv * viewHeight,
      width: w.value,
      height: h.value,
      opacity: visible ? 1 : 0,
    };
  });
  const tagStyle = useAnimatedStyle(() => {
    const { du, dv, visible } = shift();
    return {
      left: tagX.value + du * viewWidth,
      top: Math.min(Math.max(tagY.value + dv * viewHeight, safeTop), safeBottom - TAG_HEIGHT),
      opacity: visible ? 1 : 0,
    };
  });

  return (
    <Animated.View
      style={StyleSheet.absoluteFill}
      entering={animate ? FadeIn.duration(240) : undefined}
      exiting={animate ? FadeOut.duration(320) : undefined}
      pointerEvents="none">
      <Animated.View style={[styles.box, obstacle ? styles.hazardBox : styles.detectBox, !strong && styles.weak, boxStyle]}>
        {strong
          ? CORNERS.map((corner) => <View key={corner.key} style={[styles.anchor, corner.style, { borderColor: color }]} />)
          : null}
      </Animated.View>
      {tag ? (
        <Animated.View style={[styles.tag, { backgroundColor: color, maxWidth: tag.maxWidth }, tagStyle]}>
          {obstacle ? <Icon name="exclamationmark.circle.fill" size={15} color={colors.white} /> : null}
          <AppText variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.tagText}>
            {text}
          </AppText>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const CORNERS = [
  { key: 'tl', style: { left: CORNER_INSET - 2, top: CORNER_INSET - 2 } },
  { key: 'tr', style: { right: CORNER_INSET - 2, top: CORNER_INSET - 2 } },
  { key: 'bl', style: { left: CORNER_INSET - 2, bottom: CORNER_INSET - 2 } },
  { key: 'br', style: { right: CORNER_INSET - 2, bottom: CORNER_INSET - 2 } },
] as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill, pointerEvents: 'none' },
  box: { position: 'absolute', borderWidth: 2, borderRadius: RADIUS },
  detectBox: {
    borderColor: colors.detection,
    boxShadow: '0px 0px 10px 0px rgba(6, 104, 225, 0.7), inset 0px 0px 8px 0px rgba(76, 155, 255, 0.35)',
  },
  hazardBox: {
    borderColor: colors.hazard,
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
    boxShadow: '0px 0px 12px 0px rgba(255, 59, 48, 0.7), inset 0px 0px 10px 0px rgba(255, 59, 48, 0.3)',
  },
  weak: { borderStyle: 'dashed', opacity: 0.75 },
  anchor: {
    position: 'absolute',
    width: ANCHOR,
    height: ANCHOR,
    borderRadius: ANCHOR / 2,
    borderWidth: 2,
    backgroundColor: colors.white,
  },
  tag: {
    position: 'absolute',
    height: TAG_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    boxShadow: '0px 2px 8px 0px rgba(0, 0, 0, 0.28)',
  },
  tagText: { color: colors.white, fontSize: 14, lineHeight: 18, fontWeight: '600', flexShrink: 1 },
});
