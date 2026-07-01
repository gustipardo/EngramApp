import { View, Text, StyleProp, ViewStyle } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
import { palette } from '../theme/colors';
import { useSettingsStore } from '../stores/useSettingsStore';

type Props = {
  width?: number;
  /** Mark fill color (the amber book + signal strokes). Defaults to the
   *  theme accent — amber[500] in dark mode, amber[700] in light. */
  color?: string;
  /** "Punch-out" color for the two horizontal text lines on the book.
   *  Should match the surface the wordmark sits on so the lines read as
   *  cutouts in the book. Defaults to the theme bg — navy[900] in dark,
   *  paper[100] in light. Pass a hex string when the wordmark sits on a
   *  non-bg surface so the lines blend with it instead. */
  punchColor?: string;
  style?: StyleProp<ViewStyle>;
  /** Show only the brand mark (square icon), no wordmark text. */
  markOnly?: boolean;
};

/**
 * Engram lockup: amber mark + "Engram" wordmark.
 *
 * Mark geometry is the same as `_design/04-cip/logo/engram-mark-{light,dark}.svg`,
 * rescaled into a 120×120 viewBox (source SVG is 200×200; scale factor 0.6).
 * The two horizontal "text" lines on the book render in the surface color
 * so they appear as cutouts — that's the visual change from the previous
 * mark, which had no inner lines.
 */
export function EngramWordmark({ width = 200, color, punchColor, style, markOnly = false }: Props) {
  const darkMode = useSettingsStore((s) => s.darkMode);
  const resolvedColor = color ?? (darkMode ? palette.amber[500] : palette.amber[700]);
  const resolvedPunch = punchColor ?? (darkMode ? palette.navy[900] : palette.paper[100]);

  const aspect = markOnly ? 1 : 342 / 120;
  const height = width / aspect;
  const markSize = markOnly ? width : height;

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', height }, style]}>
      <Svg width={markSize} height={markSize} viewBox="0 0 120 120">
        {/* Book card */}
        <Rect x={16.8} y={18} width={64.8} height={84} rx={6.96} fill={resolvedColor} />
        {/* Two horizontal "text" lines on the book, punched out to the
          * surface color. Coords mirror the design-system 200×200 SVG
          * scaled by 0.6: x=51.76→31.06, y=68.80→41.28, w=60.48→36.29,
          * h=6.40→3.84, rx=3.20→1.92; second line at y=113.60→68.16. */}
        <Rect x={31.06} y={41.28} width={36.29} height={3.84} rx={1.92} fill={resolvedPunch} />
        <Rect x={31.06} y={68.16} width={36.29} height={3.84} rx={1.92} fill={resolvedPunch} opacity={0.55} />
        {/* Three signal strokes on the right (knowledge/voice). */}
        <Line x1={90} y1={48.6} x2={103.87} y2={41.23} stroke={resolvedColor} strokeWidth={4.56} strokeLinecap="round" opacity={0.5} />
        <Line x1={90} y1={60} x2={110.33} y2={60} stroke={resolvedColor} strokeWidth={4.56} strokeLinecap="round" opacity={0.9} />
        <Line x1={90} y1={71.4} x2={103.87} y2={78.77} stroke={resolvedColor} strokeWidth={4.56} strokeLinecap="round" opacity={0.5} />
      </Svg>
      {!markOnly && (
        <Text
          style={{
            marginLeft: 12,
            fontSize: height * 0.46,
            lineHeight: height,
            fontWeight: '500',
            color: resolvedColor,
            letterSpacing: -0.6,
            fontFamily: 'serif',
          }}
        >
          Engram
        </Text>
      )}
    </View>
  );
}
