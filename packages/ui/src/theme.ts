import { rangeError, typeError } from '../../shared/errors.js';
import { parseRgba } from './color.js';

/** The colour roles of a theme: `#rrggbb` or `#rrggbbaa` strings. A `on*` colour is the text drawn on its fill. */
export interface ThemeColors {
  /** Behind everything, for example a full-screen menu backdrop. */
  background: string;
  /** Panels, dialogs, list rows. */
  surface: string;
  /** Controls on a surface: buttons, sliders, slots. */
  surfaceRaised: string;
  /** Wells: progress tracks, text fields, empty slots. */
  surfaceSunken: string;
  /** Outlines of controls. Meets 3:1 against `surface`. */
  border: string;
  /** Body text. Meets 4.5:1 (7:1 in high contrast) against `surface` and `surfaceRaised`. */
  text: string;
  /** Secondary text. Meets 4.5:1 against `surface`. */
  textMuted: string;
  /** Main action and selection. */
  primary: string;
  onPrimary: string;
  /** Second accent, for highlights and the second series of a bar. */
  accent: string;
  onAccent: string;
  /** Good, full, done. */
  success: string;
  onSuccess: string;
  /** Careful, low. */
  warning: string;
  onWarning: string;
  /** Bad, critical, destructive. */
  danger: string;
  onDanger: string;
  /** Neutral information. */
  info: string;
  onInfo: string;
  /** The keyboard and gamepad focus ring. Meets 3:1 against `surface`, `surfaceRaised` and `primary`. */
  focus: string;
  /** Fill of a disabled control. */
  disabled: string;
  /** Text of a disabled control. */
  onDisabled: string;
  /** Dims the game behind a modal dialog. */
  scrim: string;
  /** Drop shadow under panels. */
  shadow: string;
}

/** Look of every widget. Create one with {@link createTheme}; the built-ins are in {@link themes}. */
export interface Theme {
  /** Shown in the screen reader mirror and in tests. */
  name: string;
  colors: ThemeColors;
  /** Corner radius of controls in UI units. */
  radius: number;
  /** Outline width of controls in UI units. */
  borderWidth: number;
  /** Focus ring width in UI units. */
  focusWidth: number;
  /** Base spacing unit in UI units; paddings and gaps are multiples of it. */
  spacing: number;
  /** Text sizes in UI units, before the user's text scale. */
  fontSize: { small: number; body: number; large: number; title: number; display: number };
  /** Blur of the drop shadow in UI units; 0 turns shadows off. */
  shadowBlur: number;
  /** Seconds of the hover, press and toggle transitions; 0 turns them off. */
  transition: number;
}

/** A theme with any field replaced; colours and sizes are merged one level down. */
export interface ThemeOverrides {
  name?: string;
  colors?: Partial<ThemeColors>;
  radius?: number;
  borderWidth?: number;
  focusWidth?: number;
  spacing?: number;
  fontSize?: Partial<Theme['fontSize']>;
  shadowBlur?: number;
  transition?: number;
}

// The status colours follow the Okabe-Ito palette (Okabe and Ito, 2002), designed to stay apart for the common colour-vision
// deficiencies. Health and other status is never shown by colour alone: bars carry a number or label and toasts a prefix.
const dark: Theme = {
  name: 'dark',
  colors: {
    background: '#0b0e13',
    surface: '#1a2029',
    surfaceRaised: '#2a3340',
    surfaceSunken: '#10151c',
    border: '#7f8ea3',
    text: '#f1f4f8',
    textMuted: '#b4bfce',
    primary: '#56b4e9',
    onPrimary: '#04141f',
    accent: '#e69f00',
    onAccent: '#1c1200',
    success: '#009e73',
    onSuccess: '#03120d',
    warning: '#f0e442',
    onWarning: '#1a1700',
    danger: '#d55e00',
    onDanger: '#150700',
    info: '#0072b2',
    onInfo: '#ffffff',
    focus: '#f0e442',
    disabled: '#222a35',
    onDisabled: '#7d8999',
    scrim: '#000000b8',
    shadow: '#00000099',
  },
  radius: 8,
  borderWidth: 1,
  focusWidth: 3,
  spacing: 8,
  fontSize: { small: 14, body: 18, large: 22, title: 32, display: 48 },
  shadowBlur: 16,
  transition: 0.12,
};
const light: Theme = {
  name: 'light',
  colors: {
    background: '#e8ecf1',
    surface: '#ffffff',
    surfaceRaised: '#e9eef4',
    surfaceSunken: '#d7dee7',
    border: '#677588',
    text: '#11151b',
    textMuted: '#465163',
    primary: '#0072b2',
    onPrimary: '#ffffff',
    accent: '#9b3d78',
    onAccent: '#ffffff',
    success: '#007a59',
    onSuccess: '#ffffff',
    warning: '#f0e442',
    onWarning: '#1a1700',
    danger: '#b34a00',
    onDanger: '#ffffff',
    info: '#005a8e',
    onInfo: '#ffffff',
    focus: '#7a2bd9',
    disabled: '#dde3ea',
    onDisabled: '#6c7889',
    scrim: '#0b0e13a6',
    shadow: '#0b0e1340',
  },
  radius: 8,
  borderWidth: 1,
  focusWidth: 3,
  spacing: 8,
  fontSize: { small: 14, body: 18, large: 22, title: 32, display: 48 },
  shadowBlur: 16,
  transition: 0.12,
};
const highContrast: Theme = {
  name: 'high-contrast',
  colors: {
    background: '#000000',
    surface: '#000000',
    surfaceRaised: '#000000',
    surfaceSunken: '#000000',
    border: '#ffffff',
    text: '#ffffff',
    textMuted: '#ffffff',
    primary: '#ffff00',
    onPrimary: '#000000',
    accent: '#56b4e9',
    onAccent: '#000000',
    success: '#4de0b4',
    onSuccess: '#000000',
    warning: '#ffff00',
    onWarning: '#000000',
    danger: '#ff9a5c',
    onDanger: '#000000',
    info: '#7cc8f2',
    onInfo: '#000000',
    focus: '#00ffff',
    disabled: '#000000',
    onDisabled: '#bfbfbf',
    scrim: '#000000e6',
    shadow: '#00000000',
  },
  radius: 4,
  borderWidth: 2,
  focusWidth: 4,
  spacing: 8,
  fontSize: { small: 16, body: 20, large: 24, title: 34, display: 50 },
  shadowBlur: 0,
  transition: 0,
};

/**
 * The built-in themes. `dark` is the default. All three use colour-blind-safe status colours (Okabe-Ito); `highContrast`
 * is black, white, yellow and cyan with thick outlines, 7:1 text, and no shadows or transitions.
 */
export const themes: Readonly<{ dark: Theme; light: Theme; highContrast: Theme }> = Object.freeze({
  dark: deepFreeze(dark),
  light: deepFreeze(light),
  highContrast: deepFreeze(highContrast),
});

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

const NUMBERS = ['radius', 'borderWidth', 'focusWidth', 'spacing', 'shadowBlur', 'transition'] as const;

/**
 * A theme made from `base` (default {@link themes}.dark) with `overrides` applied. Colours must be hex strings and sizes
 * finite numbers of at least 0 (font sizes above 0). The result is frozen.
 * @throws TypeError for an unknown field or a colour that does not parse.
 * @throws RangeError for a size outside its range.
 */
export function createTheme(overrides: ThemeOverrides = {}, base: Theme = themes.dark): Theme {
  const allowed = new Set(['name', 'colors', 'fontSize', ...NUMBERS]);
  for (const key of Object.keys(overrides))
    if (!allowed.has(key)) throw typeError(`Unknown theme field '${key}'`, 'ui');
  const colors = { ...base.colors, ...overrides.colors } as ThemeColors;
  for (const [key, value] of Object.entries(colors)) {
    if (!(key in base.colors)) throw typeError(`Unknown theme colour '${key}'`, 'ui');
    parseRgba(value);
  }
  const fontSize = { ...base.fontSize, ...overrides.fontSize };
  for (const [key, value] of Object.entries(fontSize)) {
    if (!(key in base.fontSize)) throw typeError(`Unknown theme font size '${key}'`, 'ui');
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      throw rangeError(`Theme font size '${key}' must be a number above 0`, 'ui');
  }
  const result: Theme = { ...base, name: overrides.name ?? base.name, colors, fontSize };
  for (const key of NUMBERS) {
    const value = overrides[key] ?? base[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw rangeError(`Theme ${key} must be a number of at least 0`, 'ui');
    result[key] = value;
  }
  return deepFreeze(result);
}

/**
 * The built-in theme that matches the user's settings: high contrast for `prefers-contrast: more` or forced colours, light
 * for `prefers-color-scheme: light`, otherwise dark. Returns dark where `matchMedia` does not exist (Node, workers).
 */
export function themeForPreferences(): Theme {
  const query = (text: string) => typeof matchMedia === 'function' && matchMedia(text).matches;
  if (query('(prefers-contrast: more)') || query('(forced-colors: active)')) return themes.highContrast;
  return query('(prefers-color-scheme: light)') ? themes.light : themes.dark;
}
