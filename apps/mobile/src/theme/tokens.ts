import { Platform, type TextStyle } from 'react-native';

/**
 * HeyNavi design tokens (light only, matching the wireframes).
 * Contrast ratios are WCAG 2.x, measured against white (#FFFFFF).
 */
export const colors = {
  white: '#FFFFFF',
  background: '#F7F9FC',
  lightBlue: '#E7F0FF',
  /** 5.15:1 on white. Safe for text and for white text on a primary fill. */
  primary: '#0668E1',
  /** 3.16:1 on white. Decorative accents and large text only, never body text. */
  secondary: '#5B8CFF',
  /** 16.7:1 on white. */
  text: '#1C1E21',
  /** 5.67:1 on white. */
  textSecondary: '#65676B',
  /** 6.54:1 on white. */
  danger: '#B3261E',
  /** 5.95:1 on white. */
  success: '#137333',
  /** Decorative borders only. */
  border: '#DCE3EE',
  disabledFill: '#E4E8EF',
  /** Overlay scrim on top of the camera preview. */
  scrim: 'rgba(28, 30, 33, 0.72)',
  /** Grouped-list canvas behind cards (Settings). */
  canvas: '#F2F5FA',
  /** Hairline separators inside cards. */
  hairline: 'rgba(28, 30, 33, 0.08)',

  // Camera screen: dark chrome around a live image.
  /** Behind and below the camera view. */
  cameraChrome: '#0B0C0F',
  /** Translucent dark glass for buttons and captions over the camera; white text on it is >= 7:1. */
  glassDark: 'rgba(16, 18, 22, 0.55)',
  /** Light frosted glass for the voice pill, status chip and answer cards over the camera. */
  glassLight: 'rgba(255, 255, 255, 0.92)',
  /** SAM boxes over the camera (wireframes 02–03): Meta blue, with a soft glow for dark scenes. */
  detection: '#0668E1',
  /** Possible obstacles over the camera (wireframe 04): bright red outlines and labels, never a filled "danger zone". */
  hazard: '#FF3B30',
  /** Hazard icons and titles on light cards (4.6:1 on white). */
  hazardOnLight: '#D92D20',
  /** Hazard text on dark glass (6.1:1 on glassDark over black). */
  hazardOnDark: '#FF8A80',
} as const;

/** Shadows: soft and low, for cards on light surfaces. */
export const shadows = {
  card: { shadowColor: '#1C1E21', shadowOpacity: 0.07, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
  raised: { shadowColor: '#0668E1', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
} as const;

/** One stroke weight and a few sizes for every SF Symbol. */
export const iconSize = { sm: 16, md: 20, lg: 24, xl: 30 } as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  card: 20,
  button: 16,
  chip: 12,
  /** Fully rounded pills and circles. */
  pill: 999,
} as const;

/** Minimum touch target in points (above Apple's 44 pt guideline, on purpose). */
export const minTouchTarget = 56;

const monoFamily = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Type scale. Sizes are base sizes: Text still scales with Dynamic Type. */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  /** Card titles and list rows. */
  subhead: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  /** Secondary metadata. Still at least 15 pt. */
  caption: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  mono: { fontSize: 15, lineHeight: 21, fontFamily: monoFamily },
} as const satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof type;
