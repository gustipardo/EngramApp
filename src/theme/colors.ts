/**
 * Engram color tokens (mirror of _design/03-tokens/tokens.json).
 * Use these from inline `style={{}}` props; for className use the Tailwind tokens.
 */

export const palette = {
  navy: {
    50:  '#E8EAF0',
    100: '#C4C9D8',
    200: '#A6ADBE',
    300: '#6E7791',
    400: '#4A5067',
    500: '#3B4668',
    600: '#2A3250',
    700: '#24304A',
    800: '#1A2339',
    850: '#11182A',
    900: '#0B1020',
    950: '#070A16',
  },
  paper: {
    50:  '#FEFCF7',
    100: '#FAF7F1',
    200: '#F3EFE6',
    300: '#EDE8DB',
    400: '#E3DCC9',
    500: '#D8CFBC',
    600: '#B6A98F',
  },
  amber: {
    50:  '#FCF3E2',
    100: '#F6DDAE',
    300: '#F1AE4A',
    500: '#E4A13F',
    600: '#C98E30',
    700: '#B87826',
    800: '#A86C22',
    900: '#8F5C1D',
  },
  sage:      { 300: '#8ABDA0', 500: '#6B9B7E', 700: '#4A7B5C' },
  terracota: { 300: '#D98E6F', 500: '#C67B5C', 700: '#A55A3D' },
} as const;

export const dark = {
  bg: {
    base:     palette.navy[900],
    surface1: palette.navy[850],
    surface2: palette.navy[800],
    surface3: palette.navy[700],
  },
  text: {
    primary:   palette.navy[50],
    secondary: palette.navy[200],
    tertiary:  palette.navy[300],
    disabled:  palette.navy[400],
    onAccent:  palette.navy[900],
  },
  accent: {
    default: palette.amber[500],
    hover:   palette.amber[300],
    pressed: palette.amber[600],
    subtleBg: 'rgba(228, 161, 63, 0.12)',
  },
  success: { default: palette.sage[500], text: palette.sage[300], subtleBg: 'rgba(107, 155, 126, 0.12)' },
  error:   { default: palette.terracota[500], text: palette.terracota[300], subtleBg: 'rgba(198, 123, 92, 0.14)' },
  border:  { default: palette.navy[600], subtle: palette.navy[700], strong: palette.navy[500] },
  scrim:   'rgba(11, 16, 32, 0.6)',
} as const;

export const light = {
  bg: {
    base:     palette.paper[100],
    surface1: palette.paper[200],
    surface2: palette.paper[300],
    surface3: palette.paper[400],
  },
  text: {
    primary:   palette.navy[850],
    secondary: palette.navy[600],
    tertiary:  palette.navy[300],
    disabled:  palette.navy[200],
    onAccent:  palette.paper[100],
  },
  accent: {
    default: palette.amber[700],
    hover:   palette.amber[800],
    pressed: palette.amber[900],
    subtleBg: 'rgba(184, 120, 38, 0.10)',
  },
  success: { default: palette.sage[700], text: palette.sage[700], subtleBg: 'rgba(74, 123, 92, 0.10)' },
  error:   { default: palette.terracota[700], text: palette.terracota[700], subtleBg: 'rgba(165, 90, 61, 0.10)' },
  border:  { default: palette.paper[500], subtle: palette.paper[400], strong: palette.paper[600] },
  scrim:   'rgba(11, 16, 32, 0.5)',
} as const;

export type ThemeColors = typeof dark;

export const theme = (mode: 'dark' | 'light'): ThemeColors => (mode === 'dark' ? dark : light);
