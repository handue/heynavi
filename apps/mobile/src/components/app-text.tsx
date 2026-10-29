import { Text, type TextProps } from 'react-native';

import { colors, type as typeScale, type TypeVariant } from '@/theme/tokens';

type Tone = 'default' | 'secondary' | 'primary' | 'danger' | 'success' | 'inverse';

const toneColor: Record<Tone, string> = {
  default: colors.text,
  secondary: colors.textSecondary,
  primary: colors.primary,
  danger: colors.danger,
  success: colors.success,
  inverse: colors.white,
};

export type AppTextProps = TextProps & {
  variant?: TypeVariant;
  tone?: Tone;
};

/** Text with the HeyNavi type scale. Font scaling (Dynamic Type) stays enabled. */
export function AppText({ variant = 'body', tone = 'default', style, ...rest }: AppTextProps) {
  return <Text style={[typeScale[variant], { color: toneColor[tone] }, style]} {...rest} />;
}
