import { View, Text, StyleProp, ViewStyle } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
import { palette } from '../theme/colors';

type Props = {
  width?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
  /** Show only the brand mark (square icon), no wordmark text. */
  markOnly?: boolean;
};

/**
 * Engram lockup: amber mark + "engram" wordmark.
 * Renders the SVG mark via react-native-svg + the wordmark as styled <Text>
 * (since no SVG font fallback in RN; uses Fraunces if loaded, else system serif).
 */
export function EngramWordmark({ width = 200, color = palette.amber[500], style, markOnly = false }: Props) {
  const aspect = markOnly ? 1 : 342 / 120;
  const height = width / aspect;
  const markSize = markOnly ? width : height;

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', height }, style]}>
      <Svg width={markSize} height={markSize} viewBox="0 0 120 120">
        <Rect x={16.8} y={18} width={64.8} height={84} rx={6.96} fill={color} />
        <Line x1={90} y1={48.6} x2={103.87} y2={41.23} stroke={color} strokeWidth={4.56} strokeLinecap="round" opacity={0.5} />
        <Line x1={90} y1={60} x2={110.33} y2={60} stroke={color} strokeWidth={4.56} strokeLinecap="round" opacity={0.9} />
        <Line x1={90} y1={71.4} x2={103.87} y2={78.77} stroke={color} strokeWidth={4.56} strokeLinecap="round" opacity={0.5} />
      </Svg>
      {!markOnly && (
        <Text
          style={{
            marginLeft: 12,
            fontSize: height * 0.46,
            lineHeight: height,
            fontWeight: '500',
            color,
            letterSpacing: -0.6,
            fontFamily: 'serif',
          }}
        >
          engram
        </Text>
      )}
    </View>
  );
}
