import { hexColor } from '@margoengine/math/color';
import type { Figure } from './figure.js';
import { colormapNames } from './colormaps.js';
import { THEMES, type Theme } from './axes.js';
import { validateThemeStyle } from './theme-style.js';
import { registerFigureCleanup } from './publication-labels.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Named, immutable per-figure styles. No import-time DOM, listeners or global settings. */
export type ThemeName = 'dark' | 'light' | 'print' | 'print-mono' | 'presentation';
/** Dark inks drawn from Tol's published muted/dark schemes; monochrome is a separate print choice. */
export const PRINT_PALETTES = Object.freeze({
  color: Object.freeze(['#332288', '#117733', '#882255', '#AA4499', '#775500', '#000000']),
  monochrome: Object.freeze(['#111111', '#444444', '#777777', '#999999']),
});
const defaults = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  titleSize: 13,
  lineWidth: 2,
  axisWidth: 1.5,
  gridWidth: 1,
  tickCount: 5,
  tickSize: 0,
  gridStyle: 'solid' as const,
};
/** Validate and freeze a complete theme, copying its palette. Overrides replace individual tokens. */
export function createTheme(base: Theme | ThemeName = 'light', overrides: Partial<Theme> = {}): Theme {
  const source = typeof base === 'string' ? THEME_PRESETS[base] : base;
  if (!source || typeof source !== 'object')
    throw typeError('Choose a named theme or a complete Theme object', 'sciviz');
  const theme = { ...source, ...overrides };
  for (const key of ['background', 'axis', 'grid', 'text'] as const)
    if (typeof theme[key] !== 'string' || theme[key].length !== 7 || !hexColor(theme[key]))
      throw typeError(`Theme ${key} needs #rrggbb; correct the colour`, 'sciviz');
  validateThemeStyle(theme);
  if (theme.scalarMap !== undefined && !colormapNames.includes(theme.scalarMap))
    throw typeError('Theme scalarMap needs a named colour map; choose colormapNames', 'sciviz');
  if (theme.palette) theme.palette = Object.freeze([...theme.palette]);
  return Object.freeze(theme);
}
const paper: Theme = {
  ...THEMES.light,
  ...defaults,
  background: '#ffffff',
  axis: '#111111',
  text: '#111111',
  grid: '#bbbbbb',
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: 11,
  titleSize: 12,
  lineWidth: 4 / 3,
  axisWidth: 2 / 3,
  gridWidth: 1 / 3,
  tickSize: 3,
  palette: PRINT_PALETTES.color,
  scalarMap: 'cividis',
};
/** Resolved presets; print-safe means a restrained ink palette, not printer/CMYK-profile certification. */
export const THEME_PRESETS: Readonly<Record<ThemeName, Theme>> = Object.freeze({
  dark: Object.freeze({ ...THEMES.dark, ...defaults }),
  light: Object.freeze({ ...THEMES.light, ...defaults }),
  print: Object.freeze(paper),
  'print-mono': Object.freeze({ ...paper, palette: PRINT_PALETTES.monochrome, scalarMap: 'gray', gridStyle: 'none' }),
  presentation: Object.freeze({
    ...THEMES.dark,
    ...defaults,
    fontSize: 18,
    titleSize: 21,
    lineWidth: 3,
    axisWidth: 2,
    gridWidth: 1,
    tickSize: 5,
  }),
});
/** Final-column dimensions and matching export options. Widths follow the publisher's final-figure guidance. */
export interface JournalPreset {
  readonly journal: 'nature' | 'ieee';
  readonly columns: 1 | 2;
  readonly widthMM: number;
  readonly heightMM: number;
  readonly theme: Theme;
  readonly css: Readonly<{ width: string; height: string }>;
  readonly raster: Readonly<{ size: Readonly<{ width: number; height: number; unit: 'mm' }>; dpi: number }>;
  readonly pdf: Readonly<{ widthMM: number }>;
}
/** Nature 89/183 mm and IEEE 88.9/182 mm. Height defaults to width*0.67; raster defaults to 300 dpi. */
export function journalPreset(
  journal: 'nature' | 'ieee',
  columns: 1 | 2 = 1,
  options: { readonly heightMM?: number; readonly dpi?: number; readonly theme?: Partial<Theme> } = {},
): JournalPreset {
  if (!['nature', 'ieee'].includes(journal) || ![1, 2].includes(columns))
    throw typeError('Choose nature/ieee and one or two columns', 'sciviz');
  const widthMM = (journal === 'nature' ? [89, 183] : [88.9, 182])[columns - 1],
    heightMM = options.heightMM ?? widthMM * 0.67,
    dpi = options.dpi ?? 300;
  if (![heightMM, dpi].every((n) => Number.isFinite(n) && n > 0) || dpi > 1000000)
    throw rangeError('Use positive finite heightMM and dpi <= 1000000', 'sciviz');
  const theme = createTheme('print', {
    fontSize: journal === 'nature' ? (6.5 * 4) / 3 : (9.5 * 4) / 3,
    titleSize: journal === 'nature' ? (7 * 4) / 3 : (10 * 4) / 3,
    ...options.theme,
  });
  return Object.freeze({
    journal,
    columns,
    widthMM,
    heightMM,
    theme,
    css: Object.freeze({ width: widthMM + 'mm', height: heightMM + 'mm' }),
    raster: Object.freeze({ size: Object.freeze({ width: widthMM, height: heightMM, unit: 'mm' as const }), dpi }),
    pdf: Object.freeze({ widthMM }),
  });
}
/** Variables are applied only to this figure's canvas and owned publication HTML roots. */
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
  return Object.freeze({
    '--margo-font-family': theme.fontFamily ?? 'system-ui, sans-serif',
    '--margo-font-size': (theme.fontSize ?? 12) + 'px',
    '--margo-title-size': (theme.titleSize ?? 13) + 'px',
    '--margo-background': theme.background,
    '--margo-axis': theme.axis,
    '--margo-grid': theme.grid,
    '--margo-text': theme.text,
    '--margo-line-width': String(theme.lineWidth ?? 2),
    '--margo-axis-width': String(theme.axisWidth ?? 1.5),
    '--margo-grid-width': String(theme.gridWidth ?? 1),
    '--margo-tick-count': String(theme.tickCount ?? 5),
    '--margo-tick-size': String(theme.tickSize ?? 0),
    '--margo-grid-style': theme.gridStyle ?? 'solid',
  });
}
/** Optional row/mark defaults for application-owned layers; explicit layer options override these values. */
export function themeLayerOptions(
  theme: Theme,
  index = 0,
  encoding: 'categorical' | 'scalar' = 'categorical',
): Readonly<{ color?: string; colormap: NonNullable<Theme['scalarMap']>; width: number }> {
  if (!Number.isSafeInteger(index) || index < 0)
    throw rangeError('Theme series index must be a nonnegative safe integer', 'sciviz');
  if (!['categorical', 'scalar'].includes(encoding))
    throw typeError('Choose categorical or scalar theme defaults; keep scalar colour data explicit', 'sciviz');
  const palette = theme.palette ?? PRINT_PALETTES.color;
  return Object.freeze({
    ...(encoding === 'categorical' ? { color: palette[index % palette.length] } : {}),
    colormap: theme.scalarMap ?? 'aurora',
    width: theme.lineWidth ?? 2,
  });
}
/** Owned, figure-scoped CSS variable binding; disposing releases listeners without changing data. */
export interface ThemeHandle {
  /** Read explicitly changed canvas CSS variables into tokens, then update every owned renderer/export consumer. */
  refresh(): Promise<void>;
  /** Stop automatic HTML-root binding and restore prior CSS variable definitions. The selected figure theme remains. */
  dispose(): void;
  [Symbol.dispose](): void;
}
const handles = new WeakMap<Figure, ThemeHandle>();
/** Apply resolved per-figure tokens. Shared chrome covers every layer; authored data colours/maps remain explicit. */
export async function applyTheme(
  figure: Figure,
  source: Theme | ThemeName = 'print',
  options: { readonly signal?: AbortSignal } = {},
): Promise<ThemeHandle> {
  options.signal?.throwIfAborted();
  const theme = createTheme(source);
  handles.get(figure)?.dispose();
  await figure.setTheme(theme, options.signal);
  options.signal?.throwIfAborted();
  const canvas = figure.engine.canvas,
    saved = new Map<HTMLElement, Map<string, [string, string]>>();
  let disposed = false;
  let variables = themeVariables(figure.theme);
  const restore = (node: HTMLElement, values: Map<string, [string, string]>) => {
    for (const [key, [value, priority]] of values)
      if (value) node.style.setProperty(key, value, priority);
      else node.style.removeProperty(key);
  };
  const bind = () => {
    if (disposed) return;
    for (const [node, values] of saved)
      if (node !== canvas && !node.isConnected) {
        restore(node, values);
        saved.delete(node);
      }
    for (const element of [canvas, ...figure.exportLayout().roots]) {
      if (!('style' in element)) continue;
      const node = element as HTMLElement;
      if (saved.has(node)) continue;
      const old = new Map<string, [string, string]>();
      saved.set(node, old);
      for (const [key, value] of Object.entries(variables)) {
        if (!old.has(key)) old.set(key, [node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
        // Existing roots may contain user edits. They are read on refresh, not overwritten each frame.
        if (!node.style.getPropertyValue(key)) node.style.setProperty(key, value);
      }
    }
  };
  bind();
  const changed = () => {
    variables = themeVariables(figure.theme);
    for (const node of saved.keys())
      for (const [key, value] of Object.entries(variables)) node.style.setProperty(key, value);
    bind();
  };
  figure.addEventListener('themechange', changed);
  const off = figure.engine.onFrame(bind);
  const unregister = registerFigureCleanup(figure, () => dispose());
  function dispose() {
    if (disposed) return;
    disposed = true;
    off();
    figure.removeEventListener('themechange', changed);
    unregister();
    options.signal?.removeEventListener('abort', dispose);
    handles.delete(figure);
    for (const [node, values] of saved) restore(node, values);
    saved.clear();
  }
  const handle: ThemeHandle = {
    async refresh() {
      if (disposed) throw fault('disposed', 'Theme handle disposed; apply a new theme', 'sciviz');
      options.signal?.throwIfAborted();
      const css = getComputedStyle(canvas),
        read = (name: string) => css.getPropertyValue('--margo-' + name).trim();
      const pixels = (name: string) => {
        const value = read(name);
        if (!/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?px$/i.test(value))
          throw typeError(`CSS --margo-${name} needs a pixel length such as 12px; correct the variable`, 'sciviz');
        return Number(value.slice(0, -2));
      };
      const next = createTheme(figure.theme, {
        fontFamily: read('font-family'),
        fontSize: pixels('font-size'),
        titleSize: pixels('title-size'),
        background: read('background'),
        axis: read('axis'),
        grid: read('grid'),
        text: read('text'),
        lineWidth: Number(read('line-width')),
        axisWidth: Number(read('axis-width')),
        gridWidth: Number(read('grid-width')),
        tickCount: Number(read('tick-count')),
        tickSize: Number(read('tick-size')),
        gridStyle: read('grid-style') as Theme['gridStyle'],
      });
      await figure.setTheme(next, options.signal);
      variables = themeVariables(next);
      for (const node of saved.keys())
        for (const [key, value] of Object.entries(variables)) node.style.setProperty(key, value);
      bind();
      figure.render();
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
  handles.set(figure, handle);
  options.signal?.addEventListener('abort', dispose, { once: true });
  figure.render();
  return handle;
}
