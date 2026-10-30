import { SymbolView, type SymbolViewProps } from 'expo-symbols';

type Props = {
  name: SymbolViewProps['name'];
  size?: number;
  color: string;
  weight?: SymbolViewProps['weight'];
  /** An SF Symbols effect, e.g. a waveform that animates while listening. */
  animation?: SymbolViewProps['animationSpec'];
};

/** An SF Symbol. Always decorative: the control around it carries the accessibility label. */
export function Icon({ name, size = 22, color, weight = 'semibold', animation }: Props) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight={weight}
      animationSpec={animation}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
