// Figure: a 3D plot or a 2D chart in a Margo Engine canvas. It owns the sciviz renderer, the axes and colour bars,
// keeps the data bounds of its layers (or fixed limits) and maps data units into a box in the scene (data z up), so
// layers of any scale share one frame. Scatter and line layers use @margoengine/points and @margoengine/lines, loaded
// with import() the first time they are used; surfaces, volumes, slices, isosurfaces, bars and heatmaps draw with
// sciviz's own pipelines. A 2D chart looks straight down through an off-centre orthographic projection that maps the
// data window onto the canvas inside its margins, and clips to that rectangle with the engine's view scissor.
import { Engine } from '@margoengine/core';
import { hexColor } from '@margoengine/math/color';
import type { EngineKernel } from '@margoengine/core';
import type { ComputeContext } from '@margoengine/compute';
import type { PointCloud, PointsPlugin } from '@margoengine/points';
import type { Line, Lines } from '@margoengine/lines';
import type { OrbitControls } from '@margoengine/controls/orbit';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { Axes, THEMES, type AxesOptions, type Theme } from './axes.js';
import { barRects, heatmapRects, histogram, type BinOptions } from './charts.js';
import { ColorBar, type ColorBarOptions } from './colorbar.js';
import type { Colormap } from './colormaps.js';
import { Interaction, type DragMode } from './interact.js';
import { IsosurfaceLayer, levelColour, type IsosurfaceLayerOptions } from './isosurface.js';
import { dataToClip, nearestPoint, screenRay, selectPoints, type SelectRegion } from './pick.js';
import { packColour, RectsLayer } from './rects.js';
import { formatValue } from './ticks.js';
import { Legend, type LegendEntry, type LegendPosition } from './legend.js';
import { axisScale, type Scale, type ScaleType } from './scales.js';
import type { PNGOptions, SVGOptions } from './export.js';
import { projectPoint } from '@margoengine/math/mat4';
import {
  dataToScene,
  extent,
  isGpuArray,
  rangeOption,
  resolveColormap,
  type Bounds,
  type ColormapSource,
  type DataSource,
} from './layer.js';
import { SciRenderer } from './render.js';
import { SurfaceLayer, type SurfaceLayerOptions } from './surface.js';
import { VolumeLayer, type VolumeLayerOptions } from './volume.js';

/** Space around a 2D chart's plot area for tick labels and titles, in CSS pixels. */
export interface Margin {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

/** Options for a figure. */
export interface FigureOptions extends AxesOptions {
  /** `'3d'` (default): a box you orbit. `'2d'`: a chart with pan (drag), zoom (wheel) and reset (double-click). */
  readonly mode?: '2d' | '3d';
  /** Space around a 2D chart's plot area. Default { top: 16, right: 24, bottom: 48, left: 64 } (right 96 with a colour bar). */
  readonly margin?: Margin;
  /** `'dark'` (default) or `'light'` chrome. */
  readonly theme?: 'dark' | 'light';
  /** Draw axes, grid and tick labels. Default true. */
  readonly axes?: boolean;
  /** Relative size of the plot box (x, y, z). Default [1, 1, 0.75]. */
  readonly aspect?: readonly [number, number, number];
  /** Fixed data limits [xmin, xmax, ymin, ymax, zmin, zmax] ([xmin, xmax, ymin, ymax] for 2D). Default: the union of the layers' bounds. */
  readonly limits?: Bounds | readonly [number, number, number, number];
  /** Most scatter points drawn per frame across the figure (level of detail beyond it). Default 2,000,000. */
  readonly pointBudget?: number;
  /**
   * How each axis maps data: `'linear'` (default), `'log'` (base 10; values at or below 0 are not drawn) or `'date'`
   * (milliseconds since 1970, as from `Date.now()` or `date.getTime()`, ticked in UTC). Surfaces, volumes and
   * isosurfaces need linear axes.
   */
  readonly scale?: { readonly x?: ScaleType; readonly y?: ScaleType; readonly z?: ScaleType };
  /**
   * The legend of named layers: shown in the top-right corner once two layers have a `name` (default), in another
   * corner (`'top-left'`, `'bottom-right'`, `'bottom-left'`), whenever one layer has a name (`true`), or never (`false`).
   */
  readonly legend?: boolean | LegendPosition;
  /** Tooltips on hover: true (default), false, or your own text for a hit (null shows none). */
  readonly tooltips?: boolean | ((hit: PickResult) => string | null);
}

/**
 * What is under the pointer: a scatter point, a line vertex, a point on a surface, a bar or a heatmap cell, in data
 * units (milliseconds on a date axis).
 */
export interface PickResult {
  readonly layer: ScatterLayer | LineLayer | SurfaceLayer | RectsLayer;
  /** The point's or vertex's index; for a surface, the nearest grid sample (j * nx + i); a bar's or cell's index. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The point's `color` data value, the surface height, the bar's height or count, or the cell's value. */
  readonly value?: number;
}

/** A finished selection: the indices of the points inside the region, per scatter and line layer. */
export interface PointSelection {
  readonly region: SelectRegion;
  readonly points: readonly { readonly layer: ScatterLayer | LineLayer; readonly indices: Uint32Array }[];
}

/** The events a figure sends: `hover` when the picked item changes, `selection` when a box or lasso drag ends. */
export interface FigureEventMap {
  hover: CustomEvent<PickResult | null>;
  selection: CustomEvent<PointSelection>;
}

/** Options for {@link Figure.create}: a figure on a new engine with orbit controls, ready to plot. */
export interface CreateFigureOptions extends FigureOptions {
  /** Orbit, zoom and pan with the mouse and touch. Default true. */
  readonly controls?: boolean;
  /** Abandons engine creation. */
  readonly signal?: AbortSignal;
}

/** Scatter data: coordinates as arrays (z optional for a flat plot), or interleaved xyz positions. */
export type ScatterData =
  | {
      readonly x: DataSource;
      readonly y: DataSource;
      readonly z?: DataSource;
      readonly color?: DataSource;
      readonly size?: DataSource;
    }
  | { readonly positions: DataSource; readonly color?: DataSource; readonly size?: DataSource };

/** Options for a scatter layer. */
export interface ScatterLayerOptions {
  /** Point size in pixels. Default 3 (2 above 200,000 points). */
  readonly size?: number;
  /** One colour for every point (`#rrggbb`) when there is no `color` data. Default the colour map's midpoint. */
  readonly color?: string;
  /** Colour map for `color` data. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Data range of the colour map. Default the colour data's min and max. */
  readonly range?: readonly [number, number];
  /** Eye-dome lighting, which outlines dense clouds. Default false. */
  readonly edl?: boolean;
  /** Round (default) or square points. */
  readonly shape?: 'round' | 'square';
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** Options for a line layer. */
export interface LineLayerOptions {
  /** Width in CSS pixels. Default 2. */
  readonly width?: number;
  /** One colour (`#rrggbb`) when there is no `color` data. Default the colour map's midpoint. */
  readonly color?: string;
  /** Colour map for `color` data. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Data range of the colour map. Default the colour data's min and max. */
  readonly range?: readonly [number, number];
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** A scatter layer (a point cloud with level of detail). Create it with `await figure.scatter(data, options)`. */
export interface ScatterLayer {
  readonly kind: 'scatter';
  /** The point cloud, for live updates (`cloud.updatePositions`). Positions are in data units. */
  readonly cloud: PointCloud;
  readonly bounds: Bounds;
  readonly count: number;
  /** Positions in plot coordinates (x, y, z per point; data units on linear axes), used for picking and selection. */
  readonly positions: Float32Array;
  /** The `color` data, if any. */
  readonly values: ArrayLike<number> | undefined;
  readonly name: string | undefined;
}

/** A line layer. Create it with `await figure.line(data, options)`. */
export interface LineLayer {
  readonly kind: 'line';
  /** The fat line. Positions are in data units. */
  readonly line: Line;
  readonly bounds: Bounds;
  /** Vertex positions in plot coordinates (data units on linear axes), used for picking and selection. */
  readonly positions: Float32Array;
  /** The `color` data, if any. */
  readonly values: ArrayLike<number> | undefined;
  readonly name: string | undefined;
}

/** Options for a bar chart. */
export interface BarLayerOptions {
  /** Bar width in data units. Default 0.8 of the smallest gap between x values. */
  readonly width?: number;
  /** Where bars start. Default 0. */
  readonly base?: number;
  /** One colour (`#rrggbb`) when there is no `color` data. Default the colour map's midpoint. */
  readonly color?: string;
  /** Colour map for `color` data. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Data range of the colour map. Default the colour data's min and max. */
  readonly range?: readonly [number, number];
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** Options for a histogram: binning, plus the bar options except width and base. */
export interface HistogramLayerOptions extends BinOptions {
  /** One colour (`#rrggbb`). Default the colour map's midpoint. */
  readonly color?: string;
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** Options for a heatmap. */
export interface HeatmapLayerOptions {
  /** Columns. Default: a GpuArray's shape [ny, nx], else the square root of the size. */
  readonly nx?: number;
  /** Rows. Default size / nx. */
  readonly ny?: number;
  /** Data x of the first and last columns' centres. Default [0, nx - 1]. */
  readonly x?: readonly [number, number];
  /** Data y of the first and last rows' centres. Default [0, ny - 1]. */
  readonly y?: readonly [number, number];
  /** Colour map. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Value range of the colour map. Default the data's min and max. */
  readonly range?: readonly [number, number];
  /** Name shown in tooltips and legends. Default none. */
  readonly name?: string;
}

/** Any figure layer. */
export type Layer = ScatterLayer | LineLayer | SurfaceLayer | VolumeLayer | IsosurfaceLayer | RectsLayer;

const read = async (data: DataSource | undefined): Promise<ArrayLike<number> | undefined> =>
  data === undefined ? undefined : isGpuArray(data) ? await data.read() : data;

const toHex = (rgb: readonly number[]): string =>
  `#${rgb
    .slice(0, 3)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

const MARGIN = { top: 16, right: 24, bottom: 48, left: 64 } as const;

// Series colours: the Okabe-Ito palette for colour vision deficiency (M. Okabe and K. Ito, "Color universal design",
// 2008), without its black, which disappears on the dark theme.
const PALETTE = ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7'];
const DAY = 86_400_000;

// Extents of each coordinate of interleaved xyz positions, skipping NaN.
const positionBounds = (p: Float32Array): Bounds => {
  const b: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < b[k * 2]) b[k * 2] = v;
      if (v > b[k * 2 + 1]) b[k * 2 + 1] = v;
    }
  for (let k = 0; k < 3; k++) if (!(b[k * 2] <= b[k * 2 + 1])) [b[k * 2], b[k * 2 + 1]] = [0, 1];
  return b;
};

const hexRGB = (hex: string, what: string): [number, number, number] => {
  const rgba = hexColor(hex);
  if (!rgba) throw typeError(`${what} ${hex} is not #rrggbb`, 'sciviz');
  return [rgba[0], rgba[1], rgba[2]];
};

// sRGB colours (0..1, three per value) from values through a colour map.
function mapColours(values: ArrayLike<number>, map: Colormap, range: readonly [number, number]): Float32Array {
  const out = new Float32Array(values.length * 3),
    table = map.table(256),
    scale = 255 / (range[1] - range[0] || 1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i],
      k = v === v ? Math.min(255, Math.max(0, Math.round((v - range[0]) * scale))) * 4 : 0;
    out[i * 3] = table[k];
    out[i * 3 + 1] = table[k + 1];
    out[i * 3 + 2] = table[k + 2];
  }
  return out;
}

/**
 * A 3D figure in an engine: scatter, line, surface, volume and isosurface layers sharing one data frame, with axes,
 * tick labels and colour bars. `Figure.create(canvas)` sets up the engine, camera and orbit controls for you.
 * @example
 * const fig = await Figure.create(canvas);
 * await fig.scatter({ x, y, z, color: temperature }, { colormap: 'ember' });
 * fig.colorbar('ember', [lo, hi], { label: 'Temperature' });
 */
export interface Figure {
  addEventListener<K extends keyof FigureEventMap>(
    type: K,
    listener: (this: Figure, event: FigureEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof FigureEventMap>(
    type: K,
    listener: (this: Figure, event: FigureEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

export class Figure extends EventTarget {
  /** The engine the figure draws in. */
  readonly engine: EngineKernel;
  /** The renderer for sciviz's own layers. */
  readonly renderer: SciRenderer;
  /** The chrome colours. */
  readonly theme: Theme;
  readonly #options: FigureOptions;
  readonly #layers = new Set<Layer>();
  readonly #bars = new Set<ColorBar>();
  #axes: Axes | undefined;
  #points: Promise<PointsPlugin> | undefined;
  #lines: Promise<Lines> | undefined;
  #compute: Promise<ComputeContext> | undefined;
  #model: Float32Array;
  #bounds: Bounds = [-1, 1, -1, 1, -1, 1];
  #ownsEngine = false;
  #controls: OrbitControls | undefined;
  #interaction: Interaction<PickResult> | undefined;
  #selection: PointSelection | undefined;
  // 2D: the data window set by setLimits() or by panning and zooming, the canvas view (clipped to the plot area) and
  // the frame hook that keeps it fitted to the canvas.
  readonly #flat: boolean;
  #window: Bounds | undefined;
  #views: {
    camera: EngineKernel['camera'];
    viewport: [number, number, number, number];
    scissor: [number, number, number, number];
  }[] = [];
  #margin: Required<Margin>;
  #offFrame: (() => void) | undefined;
  #axesQueued = false;
  // Axis scales (a date axis takes its origin from the first data it sees), the legend and the next series colour.
  readonly #scales: [Scale, Scale, Scale];
  readonly #dated = [false, false, false];
  #legend: Legend | undefined;
  #series = 0;
  // Colours and widths of scatter and line layers, for SVG export.
  readonly #styles = new WeakMap<Layer, { color: string; colors?: Float32Array; width: number }>();
  // Axis updates run after one another; ready() waits for them and reports their errors.
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  /** Adds a figure to `engine` (WebGPU backend). The engine's camera, controls and background are left to you. */
  static attach(engine: EngineKernel, options: FigureOptions = {}): Figure {
    return new Figure(engine, options);
  }

  /**
   * A figure on a new engine in `canvas`: the theme's background, a camera framing the plot box and orbit controls,
   * running. Dispose the figure to dispose the engine.
   */
  static async create(canvas: HTMLCanvasElement, options: CreateFigureOptions = {}): Promise<Figure> {
    options.signal?.throwIfAborted();
    const engine = await Engine.create(canvas, { backend: 'webgpu' });
    if (options.signal?.aborted) {
      engine.dispose();
      throw options.signal.reason;
    }
    const figure = new Figure(engine, options);
    figure.#ownsEngine = true;
    engine.scene.background = figure.theme.background;
    if (!figure.#flat) {
      engine.camera.position = [2.6, 1.7, 2.9];
      engine.camera.target = [0, 0, 0];
      engine.camera.near = 0.01;
      engine.camera.far = 100;
    }
    if (!figure.#flat && (options.controls ?? true)) {
      const { OrbitControls } = await import('@margoengine/controls/orbit');
      const orbit = OrbitControls.attach(engine);
      orbit.enableDamping = true;
      orbit.minDistance = 0.5;
      orbit.maxDistance = 20;
      figure.#controls = orbit;
    }
    engine.start();
    return figure;
  }

  /** @internal Use {@link Figure.attach} or {@link Figure.create}. */
  constructor(engine: EngineKernel, options: FigureOptions = {}) {
    super();
    const theme = options.theme ?? 'dark';
    if (theme !== 'dark' && theme !== 'light')
      throw typeError(`Figure theme must be 'dark' or 'light', got ${String(theme)}`, 'sciviz');
    const aspect = options.aspect ?? [1, 1, 0.75];
    if (aspect.length !== 3 || !aspect.every((a) => a > 0 && Number.isFinite(a)))
      throw rangeError('Figure aspect must be three positive numbers', 'sciviz');
    const mode = options.mode ?? '3d';
    if (mode !== '2d' && mode !== '3d')
      throw typeError(`Figure mode must be '2d' or '3d', got ${String(mode)}`, 'sciviz');
    this.#flat = mode === '2d';
    if (options.limits) this.#checkBounds(options.limits, 'Figure limits');
    this.#margin = this.#checkMargin(options.margin);
    const types = options.scale ?? {};
    this.#scales = [axisScale(types.x), axisScale(types.y), axisScale(types.z)];
    this.engine = engine;
    this.theme = THEMES[theme];
    this.#options = options;
    this.renderer = SciRenderer.attach(engine);
    if (options.axes ?? true) this.#axes = new Axes(engine, this.theme, options, () => this.#linesPlugin());
    this.#model = dataToScene(this.#bounds, aspect);
    const canvas = (engine as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)
      this.#interaction = new Interaction<PickResult>(canvas, this.theme, {
        pick: (x, y) => (this.#layers.size ? this.pick(x, y) : null),
        describe: (hit) => this.#describe(hit),
        hover: (hit) => this.dispatchEvent(new CustomEvent('hover', { detail: hit })),
        select: (region) => {
          this.select(region);
        },
        controls: () => this.#controls,
        navigate: this.#flat
          ? {
              pan: (dx, dy) => this.#pan(dx, dy),
              zoom: (f, x, y) => this.#zoom(f, x, y),
              reset: () => this.setLimits(),
            }
          : undefined,
      });
    if (this.#flat) this.#setup2d();
  }

  #checkMargin(margin: Margin | undefined): Required<Margin> {
    const m = { ...MARGIN, ...margin };
    for (const [side, v] of Object.entries(m))
      if (!(v >= 0) || !Number.isFinite(v))
        throw rangeError(`Figure margin ${side} must be a finite number of pixels, at least 0, got ${v}`, 'sciviz');
    return m;
  }

  /** True for a 2D chart (`mode: '2d'`). */
  get is2d(): boolean {
    return this.#flat;
  }

  // 2D: a camera straight down on the plot box, an off-centre orthographic projection that maps the box onto the
  // canvas inside the margins, and a canvas view whose scissor clips drawing to that rectangle.
  #setup2d(): void {
    const camera = this.engine.camera;
    camera.position = [0, 10, 0];
    camera.target = [0, 0, 0];
    camera.up = [0, 0, -1];
    camera.near = 0.01;
    camera.far = 100;
    camera.project = (out, _aspect, webgpu) => {
      const { width, height } = this.#canvasSize(),
        m = this.#margin;
      const l = -1 + (2 * m.left) / width,
        r = 1 - (2 * m.right) / width,
        b = -1 + (2 * m.bottom) / height,
        t = 1 - (2 * m.top) / height,
        n = camera.near,
        f = camera.far;
      out[0] = (r - l) / 2;
      out[12] = (r + l) / 2;
      out[5] = (t - b) / 2;
      out[13] = (t + b) / 2;
      // Reversed-Z depth for WebGPU (near 1, far 0); -1..1 for WebGL2.
      out[10] = webgpu ? 1 / (f - n) : -2 / (f - n);
      out[14] = webgpu ? f / (f - n) : -(f + n) / (f - n);
      out[15] = 1;
    };
    this.#views = [{ camera, viewport: [0, 0, 1, 1], scissor: [0, 0, 1, 1] }];
    this.#fitView();
    (this.engine as unknown as { views: unknown }).views = this.#views;
    this.#offFrame = this.engine.onFrame(() => this.#fitView());
  }

  #canvasSize(): { width: number; height: number } {
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    return { width: canvas.clientWidth || canvas.width || 1, height: canvas.clientHeight || canvas.height || 1 };
  }

  // The scissor follows the plot area (one pixel wider each side, so the frame's lines show whole).
  #fitView(): void {
    const { width, height } = this.#canvasSize(),
      m = this.#margin;
    const x = Math.max(0, m.left - 1) / width,
      y = Math.max(0, m.top - 1) / height;
    this.#views[0].scissor = [
      x,
      y,
      Math.max(0, Math.min(1 - x, (width - m.left - m.right + 2) / width)),
      Math.max(0, Math.min(1 - y, (height - m.top - m.bottom + 2) / height)),
    ];
  }

  // Pans the 2D window by a pointer move of (dx, dy) CSS pixels.
  #pan(dx: number, dy: number): void {
    const [x0, x1, y0, y1] = this.#bounds,
      { width, height } = this.#canvasSize(),
      m = this.#margin;
    const sx = (x1 - x0) / Math.max(1, width - m.left - m.right),
      sy = (y1 - y0) / Math.max(1, height - m.top - m.bottom);
    this.#window = [x0 - dx * sx, x1 - dx * sx, y0 + dy * sy, y1 + dy * sy, -1, 1];
    this.#refit();
  }

  // Zooms the 2D window by `factor` (below 1 zooms in) about the data point under (x, y) CSS pixels.
  #zoom(factor: number, x: number, y: number): void {
    const [x0, x1, y0, y1] = this.#bounds,
      { width, height } = this.#canvasSize(),
      m = this.#margin;
    const u = Math.min(1, Math.max(0, (x - m.left) / Math.max(1, width - m.left - m.right))),
      v = Math.min(1, Math.max(0, (y - m.top) / Math.max(1, height - m.top - m.bottom)));
    const cx = x0 + u * (x1 - x0),
      cy = y1 - v * (y1 - y0);
    this.#window = [
      cx - (cx - x0) * factor,
      cx + (x1 - cx) * factor,
      cy - (cy - y0) * factor,
      cy + (y1 - cy) * factor,
      -1,
      1,
    ];
    this.#refit();
  }

  /**
   * Sets the data window: [xmin, xmax, ymin, ymax, zmin, zmax], or [xmin, xmax, ymin, ymax] for a 2D chart. With no
   * argument, goes back to the `limits` option or the layers' bounds. Panning and zooming a 2D chart set it too.
   */
  setLimits(limits?: Bounds | readonly [number, number, number, number]): void {
    this.#check();
    if (limits) this.#checkBounds(limits, 'Figure limits');
    this.#window = limits ? this.#full(limits) : undefined;
    this.#refit();
  }

  #full(b: Bounds | readonly [number, number, number, number]): Bounds {
    return b.length === 4 ? [b[0], b[1], b[2], b[3], -1, 1] : ([...b] as Bounds);
  }

  /**
   * Draws one frame now (also while the engine is stopped), through the 2D chart's clipped view when there is one.
   * Use it before reading the canvas.
   */
  render(): void {
    this.#check();
    if (this.#flat) {
      this.#fitView();
      this.engine.render({ views: this.#views });
    } else this.engine.render();
  }

  #describe(hit: PickResult): string | null {
    const tooltips = this.#options.tooltips ?? true;
    if (typeof tooltips === 'function') return tooltips(hit);
    if (!tooltips) return null;
    const titles = this.#options.titles ?? {},
      name = hit.layer.name,
      // Dates read as UTC date and time.
      show = (axis: number, v: number) =>
        this.#scales[axis].type === 'date' && Number.isFinite(v)
          ? new Date(v).toISOString().slice(0, 19).replace('T', ' ')
          : formatValue(v),
      lines = [`${titles.x ?? 'x'} ${show(0, hit.x)}`, `${titles.y ?? 'y'} ${show(1, hit.y)}`];
    if (!this.#flat) lines.push(`${titles.z ?? 'z'} ${show(2, hit.z)}`);
    if (hit.value !== undefined && !(hit.layer instanceof SurfaceLayer)) lines.push(`value ${formatValue(hit.value)}`);
    return name ? `${name}\n${lines.join('\n')}` : lines.join('\n');
  }

  /**
   * How a left-button drag on the canvas acts: `'orbit'` (3D default) or `'pan'` (2D default) moves the view; `'box'`
   * and `'lasso'` select.
   */
  get dragMode(): DragMode {
    return this.#interaction?.mode ?? (this.#flat ? 'pan' : 'orbit');
  }
  set dragMode(mode: DragMode) {
    if (mode !== 'orbit' && mode !== 'pan' && mode !== 'box' && mode !== 'lasso')
      throw typeError(`dragMode must be 'orbit', 'pan', 'box' or 'lasso', got ${String(mode)}`, 'sciviz');
    if (this.#interaction) this.#interaction.mode = mode;
  }

  /** The last selection, or undefined. */
  get selection(): PointSelection | undefined {
    return this.#selection;
  }

  /**
   * The orbit controls {@link Figure.create} attached (undefined with `controls: false` or {@link Figure.attach}).
   * Listen for their `change` event to follow the camera.
   */
  get controls(): OrbitControls | undefined {
    return this.#controls;
  }

  // Camera clip times the data-to-scene transform, and the canvas size in CSS pixels.
  #view(): { matrix: Float64Array; width: number; height: number } {
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    return {
      matrix: dataToClip(this.engine.camera.matrix, this.#model),
      width: canvas.clientWidth || canvas.width,
      height: canvas.clientHeight || canvas.height,
    };
  }

  /**
   * What is under (x, y), in CSS pixels from the canvas's top-left (`event.offsetX`, `event.offsetY`): the nearest
   * scatter point or line vertex within `radius` pixels (default 8), else the nearest surface under the pointer.
   * Uses the camera of the last frame. Surfaces that read a GpuArray are not picked (their heights stay on the GPU).
   */
  pick(x: number, y: number, options: { readonly radius?: number } = {}): PickResult | null {
    this.#check();
    const radius = options.radius ?? 8;
    if (!(radius >= 0)) throw rangeError(`pick radius must be at least 0, got ${radius}`, 'sciviz');
    const { matrix, width, height } = this.#view();
    let best: PickResult | null = null,
      bestDistance = Infinity;
    for (const layer of this.#layers) {
      if (!('kind' in layer) || (layer.kind !== 'scatter' && layer.kind !== 'line')) continue;
      const near = nearestPoint(matrix, layer.positions, width, height, x, y, radius);
      if (near && near.distance < bestDistance) {
        const p = layer.positions,
          i = near.index;
        bestDistance = near.distance;
        best = {
          layer,
          index: i,
          x: this.#inverse(0, p[i * 3]),
          y: this.#inverse(1, p[i * 3 + 1]),
          z: this.#inverse(2, p[i * 3 + 2]),
          value: layer.values?.[i],
        };
      }
    }
    if (best) return best;
    const ray = screenRay(matrix, width, height, x, y);
    if (!ray) return null;
    // Bars and cells: the rectangle under the pointer's data position (a 2D chart looks straight down).
    const rects = [...this.#layers].filter((l): l is RectsLayer => l instanceof RectsLayer).reverse();
    for (const layer of rects) {
      const k = layer.indexAt(ray.origin[0], ray.origin[1]);
      if (k < 0) continue;
      const r = layer.rects;
      return {
        layer,
        index: k,
        x: this.#inverse(0, (r[k * 4] + r[k * 4 + 2]) / 2),
        y: layer.kind === 'heatmap' ? this.#inverse(1, (r[k * 4 + 1] + r[k * 4 + 3]) / 2) : layer.values[k],
        z: 0,
        value: layer.values[k],
      };
    }
    let nearest = Infinity;
    for (const layer of this.#layers) {
      if (!(layer instanceof SurfaceLayer)) continue;
      const hit = layer.raycast(ray.origin, ray.direction);
      if (hit && hit.t < nearest) {
        nearest = hit.t;
        best = { layer, index: hit.index, x: hit.x, y: hit.y, z: hit.z, value: hit.z };
      }
    }
    return best;
  }

  /**
   * Selects the scatter points and line vertices whose screen positions fall in `region` (CSS pixels from the canvas's
   * top-left: `{ rect: [x0, y0, x1, y1] }` or `{ polygon: [x, y, ...] }`), stores it as `selection` and sends a
   * `selection` event. A box or lasso drag (see `dragMode`) calls this.
   */
  select(region: SelectRegion): PointSelection {
    this.#check();
    if (!region || (!('rect' in region) && !('polygon' in region)))
      throw typeError('select takes { rect: [x0, y0, x1, y1] } or { polygon: [x, y, ...] }', 'sciviz');
    const { matrix, width, height } = this.#view();
    const points: { layer: ScatterLayer | LineLayer; indices: Uint32Array }[] = [];
    for (const layer of this.#layers)
      if ('kind' in layer && (layer.kind === 'scatter' || layer.kind === 'line'))
        points.push({ layer, indices: selectPoints(matrix, layer.positions, width, height, region) });
    const selection: PointSelection = { region, points };
    this.#selection = selection;
    this.dispatchEvent(new CustomEvent('selection', { detail: selection }));
    return selection;
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Figure disposed; create a new one', 'sciviz');
  }

  #checkBounds(b: readonly number[], what: string): void {
    const four = this.#flat && b.length === 4;
    if ((b.length !== 6 && !four) || !b.every(Number.isFinite) || b[1] < b[0] || b[3] < b[2] || (!four && b[5] < b[4]))
      throw rangeError(
        `${what} must be [xmin, xmax, ymin, ymax, zmin, zmax]${this.#flat ? ' or [xmin, xmax, ymin, ymax]' : ''} with finite numbers, each min <= max`,
        'sciviz',
      );
  }

  #need3d(what: string): void {
    if (this.#flat) throw fault('unsupported', `${what} needs a 3D figure; create it without mode: '2d'`, 'sciviz');
  }

  #need2d(what: string): void {
    if (!this.#flat)
      throw fault('unsupported', `${what} needs a 2D chart: Figure.create(canvas, { mode: '2d' })`, 'sciviz');
  }

  /** The data bounds the box shows: the fixed limits, or the union of the layers' bounds. */
  get bounds(): Bounds {
    return [...this.#bounds] as Bounds;
  }

  /** The data-to-scene transform (column-major 4x4): data x, y, z to scene x, -z, y inside the plot box. */
  get model(): Float32Array {
    return this.#model;
  }

  // The one lines plugin per figure, shared by line layers and the axes.
  #linesPlugin(): Promise<Lines> {
    return (this.#lines ??= import('@margoengine/lines').then(({ Lines }) => Lines.attach(this.engine)));
  }

  /**
   * Resolves once the axes, tick labels and other updates started by adding or removing layers are done; rejects with
   * the error if one failed.
   */
  ready(): Promise<void> {
    return this.#pending;
  }

  /** The layers, in the order they were added. */
  get layers(): readonly Layer[] {
    return [...this.#layers];
  }

  // Recomputes the bounds and pushes the transform to every layer and the axes.
  #refit(): void {
    const fixed = this.#window ?? (this.#options.limits ? this.#full(this.#options.limits) : undefined);
    let b: Bounds | undefined = fixed ? ([...fixed] as Bounds) : undefined;
    if (!b)
      for (const layer of this.#layers) {
        const lb = layer.bounds;
        b = b
          ? [
              Math.min(b[0], lb[0]),
              Math.max(b[1], lb[1]),
              Math.min(b[2], lb[2]),
              Math.max(b[3], lb[3]),
              Math.min(b[4], lb[4]),
              Math.max(b[5], lb[5]),
            ]
          : [...lb];
      }
    b ??= [-1, 1, -1, 1, -1, 1];
    if (this.#flat) {
      // A chart pads fitted data by 4% so points and lines at the edges show whole; its z spans the layer depths.
      if (!fixed) {
        const px = (b[1] - b[0] || 1) * 0.04,
          py = (b[3] - b[2] || 1) * 0.04;
        b = [b[0] - px, b[1] + px, b[2] - py, b[3] + py, -1, 1];
      }
      b[4] = -1;
      b[5] = 1;
    }
    this.#bounds = b;
    this.#model = dataToScene(this.#bounds, this.#flat ? [1, 1, 1] : (this.#options.aspect ?? [1, 1, 0.75]));
    for (const layer of this.#layers) {
      if ('kind' in layer && layer.kind === 'scatter') layer.cloud.matrix.set(this.#model);
      else if ('kind' in layer && layer.kind === 'line') layer.line.setMatrix(this.#model);
      else layer.setModel(this.#model);
    }
    // One queued axes update at a time: it draws whatever the bounds are when it runs.
    if (this.#axes && !this.#axesQueued) {
      this.#axesQueued = true;
      this.#pending = this.#pending.then(() => {
        this.#axesQueued = false;
        return this.#axes!.update(this.#bounds, this.#model, this.#flat, this.#scales);
      });
    }
  }

  #add<L extends Layer>(layer: L): L {
    this.#layers.add(layer);
    this.#refit();
    this.#updateLegend();
    return layer;
  }

  // The plot coordinate function of an axis. A date axis takes its origin, the first finite value's UTC midnight,
  // from the first data it maps, so 32-bit positions keep millisecond-scale precision across years.
  #forward(axis: number, values?: ArrayLike<number>): (v: number) => number {
    const s = this.#scales[axis];
    if (s.type === 'date' && !this.#dated[axis] && values) {
      for (let i = 0; i < values.length; i++)
        if (Number.isFinite(values[i])) {
          this.#scales[axis] = axisScale('date', Math.floor(values[i] / DAY) * DAY);
          this.#dated[axis] = true;
          break;
        }
    }
    return this.#scales[axis].forward;
  }

  #inverse(axis: number, v: number): number {
    return this.#scales[axis].inverse(v);
  }

  #linear(what: string): void {
    if (this.#scales.some((s) => s.type !== 'linear'))
      throw fault('unsupported', `${what} needs linear axes; create the figure without scale`, 'sciviz');
  }

  // The next colour of the series palette, as sRGB.
  #nextColour(): [number, number, number] {
    return hexRGB(PALETTE[this.#series++ % PALETTE.length], 'palette colour');
  }

  #updateLegend(): void {
    const option = this.#options.legend;
    if (option === false) return;
    const entries: LegendEntry[] = [];
    for (const layer of this.#layers) {
      const name = 'name' in layer ? layer.name : undefined;
      if (!name) continue;
      if (layer instanceof RectsLayer) entries.push({ name, color: layer.swatch, shape: 'square' });
      else if (layer instanceof SurfaceLayer)
        entries.push({ name, color: toHex(layer.colormap.sample(0.6)), shape: 'square' });
      else if ('kind' in layer && (layer.kind === 'scatter' || layer.kind === 'line'))
        entries.push({
          name,
          color: this.#styles.get(layer)?.color ?? '#ffffff',
          shape: layer.kind === 'line' ? 'line' : 'dot',
        });
    }
    const show = entries.length >= (option === true ? 1 : 2);
    if (!show) {
      if (this.#legend) this.#legend.element.hidden = true;
      return;
    }
    const canvas = (this.engine as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (!canvas || typeof document === 'undefined') return;
    this.#legend ??= new Legend(canvas, this.theme);
    const inset = this.#flat ? this.#margin : { top: 0, right: 0, bottom: 0, left: 0 };
    this.#legend.update(entries, typeof option === 'string' ? option : 'top-right', inset);
  }

  /** The legend, once shown. */
  get legend(): Legend | undefined {
    return this.#legend;
  }

  /**
   * A scatter plot: points at (x, y, z) (z omitted for a flat plot) or interleaved `positions`, coloured by `color`
   * data through a colour map, with per-point `size` multipliers. Millions of points draw with level of detail.
   * GpuArray inputs are read back once.
   */
  async scatter(data: ScatterData, options: ScatterLayerOptions = {}): Promise<ScatterLayer> {
    this.#check();
    if (!data || typeof data !== 'object')
      throw typeError('scatter takes { x, y, z?, color?, size? } or { positions }', 'sciviz');
    let positions: Float32Array;
    let bounds: Bounds;
    if ('positions' in data) {
      const p = await read(data.positions);
      if (!p || p.length % 3) throw rangeError('scatter positions must hold x, y, z per point', 'sciviz');
      if (this.#scales.every((s) => s.type === 'linear') && !this.#flat)
        positions = p instanceof Float32Array ? p : Float32Array.from(p);
      else {
        // Each coordinate through its axis scale (in double precision) before rounding to 32 bits.
        const n = p.length / 3,
          first = (k: number) => Float64Array.from({ length: Math.min(n, 1) }, () => p[k]),
          fx = this.#forward(0, first(0)),
          fy = this.#forward(1, first(1)),
          fz = this.#forward(2, first(2));
        positions = new Float32Array(p.length);
        for (let i = 0; i < n; i++) {
          positions[i * 3] = fx(p[i * 3]);
          positions[i * 3 + 1] = fy(p[i * 3 + 1]);
          positions[i * 3 + 2] = this.#flat ? 0 : fz(p[i * 3 + 2]);
        }
      }
      bounds = positionBounds(positions);
    } else {
      const [x, y, z] = await Promise.all([read(data.x), read(data.y), read(data.z)]);
      if (!x || !y || x.length !== y.length || (z && z.length !== x.length))
        throw rangeError('scatter x, y and z must have one length', 'sciviz');
      const fx = this.#forward(0, x),
        fy = this.#forward(1, y),
        fz = this.#forward(2, z);
      positions = new Float32Array(x.length * 3);
      for (let i = 0; i < x.length; i++) {
        positions[i * 3] = fx(x[i]);
        positions[i * 3 + 1] = fy(y[i]);
        positions[i * 3 + 2] = z && !this.#flat ? fz(z[i]) : 0;
      }
      bounds = positionBounds(positions);
    }
    const count = positions.length / 3,
      map = resolveColormap(options.colormap);
    const colourData = await read(data.color),
      sizeData = await read(data.size);
    if (colourData && colourData.length !== count)
      throw rangeError(`scatter color has ${colourData.length} values for ${count} points`, 'sciviz');
    if (sizeData && sizeData.length !== count)
      throw rangeError(`scatter size has ${sizeData.length} values for ${count} points`, 'sciviz');
    const colours = colourData
      ? mapColours(colourData, map, rangeOption(options.range, 'scatter range') ?? extent(colourData))
      : undefined;
    const uniform = options.color
      ? hexRGB(options.color, 'scatter color')
      : colourData || options.colormap
        ? map.sample(0.6)
        : this.#nextColour();
    const plugin = await (this.#points ??= import('@margoengine/points').then(({ PointsPlugin }) =>
      PointsPlugin.attach(this.engine, { pointBudget: this.#options.pointBudget ?? 2_000_000 }),
    ));
    const { PointCloud } = await import('@margoengine/points');
    this.#check();
    const cloud = plugin.add(
      new PointCloud({
        positions,
        colors: colours,
        sizes: sizeData ? Float32Array.from(sizeData) : undefined,
        material: {
          size: options.size ?? (count > 200_000 ? 2 : 3),
          shape: options.shape ?? 'round',
          edl: options.edl ?? false,
          color: colours ? '#ffffff' : (uniform.map((c) => c) as [number, number, number]),
        },
      }),
    );
    const style = { color: toHex(uniform), colors: colours, width: options.size ?? (count > 200_000 ? 2 : 3) };
    return this.#style(style, {
      kind: 'scatter',
      cloud,
      bounds,
      count,
      positions,
      values: colourData,
      name: options.name,
    });
  }

  /** A line plot through (x, y, z) (z omitted for a flat line), coloured by `color` data through a colour map. */
  async line(
    data: { readonly x: DataSource; readonly y: DataSource; readonly z?: DataSource; readonly color?: DataSource },
    options: LineLayerOptions = {},
  ): Promise<LineLayer> {
    this.#check();
    const [x, y, z, c] = await Promise.all([read(data.x), read(data.y), read(data.z), read(data.color)]);
    if (!x || !y || x.length !== y.length || (z && z.length !== x.length) || x.length < 2)
      throw rangeError('line x, y and z must have one length of at least 2', 'sciviz');
    const positions = new Float32Array(x.length * 3),
      fx = this.#forward(0, x),
      fy = this.#forward(1, y),
      fz = this.#forward(2, z);
    for (let i = 0; i < x.length; i++)
      [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] = [
        fx(x[i]),
        fy(y[i]),
        z && !this.#flat ? fz(z[i]) : 0,
      ];
    const map = resolveColormap(options.colormap);
    if (c && c.length !== x.length)
      throw rangeError(`line color has ${c.length} values for ${x.length} points`, 'sciviz');
    const colours = c ? mapColours(c, map, rangeOption(options.range, 'line range') ?? extent(c)) : undefined;
    const lines = await this.#linesPlugin();
    const { Line } = await import('@margoengine/lines');
    this.#check();
    const colour = options.color ?? toHex(c || options.colormap ? map.sample(0.6) : this.#nextColour());
    const line = lines.add(
      new Line({
        positions,
        colors: colours,
        color: colours ? '#ffffff' : colour,
        width: options.width ?? 2,
        join: 'round',
        cap: 'round',
      }),
    );
    return this.#style(
      { color: colours ? '#ffffff' : colour, colors: colours, width: options.width ?? 2 },
      {
        kind: 'line',
        line,
        bounds: positionBounds(positions),
        positions,
        values: c,
        name: options.name,
      },
    );
  }

  /** A surface plot of heights `z` over a grid (`nx` columns; a GpuArray of shape [ny, nx] is read in place). */
  surface(z: DataSource, options: SurfaceLayerOptions = {}): SurfaceLayer {
    this.#check();
    this.#need3d('A surface');
    this.#linear('A surface');
    const layer = new SurfaceLayer(this.renderer, z, options);
    this.renderer.add(layer);
    return this.#add(layer);
  }

  /** A volume rendering of a 3D grid (x fastest; a GpuArray of shape [nz, ny, nx] is uploaded on the GPU). */
  volume(data: DataSource, options: VolumeLayerOptions = {}): VolumeLayer {
    this.#check();
    this.#need3d('A volume');
    this.#linear('A volume');
    const layer = new VolumeLayer(this.renderer, data, options);
    this.renderer.add(layer);
    return this.#add(layer);
  }

  /**
   * An isosurface of a 3D grid at `level`, extracted by marching cubes on the GPU. Resolves once the surface is
   * built; `layer.update(level)` extracts another level.
   */
  async isosurface(data: DataSource, level: number, options: IsosurfaceLayerOptions = {}): Promise<IsosurfaceLayer> {
    this.#check();
    this.#need3d('An isosurface');
    this.#linear('An isosurface');
    const gpu = await (this.#compute ??= import('@margoengine/compute').then(({ createCompute }) =>
      createCompute({ engine: this.engine }),
    ));
    const layer = new IsosurfaceLayer(this.renderer, gpu, data, {
      ...options,
      color: options.color ?? levelColour(level, options.range, options.colormap),
    });
    try {
      await layer.update(level, { signal: options.signal });
    } catch (error) {
      layer.dispose();
      throw error;
    }
    this.renderer.add(layer);
    return this.#add(layer);
  }

  #rects(
    kind: 'bar' | 'histogram' | 'heatmap',
    rects: Float32Array,
    values: Float32Array,
    colours: Uint32Array,
    name: string | undefined,
    swatch: string,
  ): RectsLayer {
    const layer = new RectsLayer(this.renderer, kind, rects, values, colours, { name, swatch });
    this.renderer.add(layer);
    return this.#add(layer);
  }

  // Packed colours for values through a colour map, or one colour for all.
  #colours(
    count: number,
    values: ArrayLike<number> | undefined,
    options: {
      readonly color?: string;
      readonly colormap?: ColormapSource;
      readonly range?: readonly [number, number];
    },
    what: string,
  ): { colours: Uint32Array; swatch: string } {
    const map = resolveColormap(options.colormap),
      colours = new Uint32Array(count);
    if (values) {
      const rgb = mapColours(values, map, rangeOption(options.range, `${what} range`) ?? extent(values));
      for (let i = 0; i < count; i++) colours[i] = packColour(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      return { colours, swatch: toHex(map.sample(0.6)) };
    }
    const one = options.color
      ? hexRGB(options.color, `${what} color`)
      : options.colormap
        ? map.sample(0.6)
        : this.#nextColour();
    colours.fill(packColour(one[0], one[1], one[2]));
    return { colours, swatch: toHex(one) };
  }

  /**
   * A bar chart (2D): one bar per (x, y) from `base` (default 0) to y, coloured by `color` data through a colour map,
   * or one colour.
   */
  async bar(
    data: { readonly x: DataSource; readonly y: DataSource; readonly color?: DataSource },
    options: BarLayerOptions = {},
  ): Promise<RectsLayer> {
    this.#check();
    this.#need2d('A bar chart');
    const [x, y, c] = await Promise.all([read(data.x), read(data.y), read(data.color)]);
    if (!x || !y || x.length !== y.length || x.length < 1)
      throw rangeError('bar x and y must have one length of at least 1', 'sciviz');
    if (c && c.length !== x.length) throw rangeError(`bar color has ${c.length} values for ${x.length} bars`, 'sciviz');
    this.#check();
    // Bars start at 0, or at 1 on a log axis (where 0 has no place).
    const fx = this.#forward(0, x),
      fy = this.#forward(1, y),
      base = fy(options.base ?? (this.#scales[1].type === 'log' ? 1 : 0));
    const rects = barRects(Float64Array.from(x, fx), Float64Array.from(y, fy), { width: options.width, base }),
      { colours, swatch } = this.#colours(x.length, c, options, 'bar');
    return this.#rects('bar', rects, Float32Array.from(y), colours, options.name, swatch);
  }

  /** A histogram (2D) of `values`: equal bins (`bins: 'auto'` by default), counts or `density` as bar heights. */
  async histogram(values: DataSource, options: HistogramLayerOptions = {}): Promise<RectsLayer> {
    this.#check();
    this.#need2d('A histogram');
    const v = await read(values);
    this.#check();
    // Bins are equal in plot coordinates: on a log x axis, equal ratios.
    const fx = this.#forward(0, v),
      fy = this.#forward(1),
      range = options.range && ([fx(options.range[0]), fx(options.range[1])] as const);
    const { edges, counts } = histogram(Float64Array.from(v!, fx), { ...options, range }),
      rects = new Float32Array(counts.length * 4),
      base = fy(this.#scales[1].type === 'log' ? 1 : 0);
    for (let k = 0; k < counts.length; k++) {
      const top = fy(counts[k]);
      // An empty bin on a log axis has no bar.
      rects.set(
        top === top
          ? [edges[k], Math.min(base, top), edges[k + 1], Math.max(base, top)]
          : [edges[k], base, edges[k], base],
        k * 4,
      );
    }
    const { colours, swatch } = this.#colours(counts.length, undefined, options, 'histogram');
    return this.#rects('histogram', rects, Float32Array.from(counts), colours, options.name, swatch);
  }

  /** A heatmap (2D): a grid of `nx` x `ny` cells (row j, column i at j * nx + i) coloured through a colour map. */
  async heatmap(values: DataSource, options: HeatmapLayerOptions = {}): Promise<RectsLayer> {
    this.#check();
    this.#need2d('A heatmap');
    const shape = isGpuArray(values) ? values.shape : undefined,
      v = (await read(values))!;
    this.#check();
    const nx = options.nx ?? (shape?.length === 2 ? shape[1] : Math.round(Math.sqrt(v.length)));
    const ny = options.ny ?? Math.round(v.length / nx);
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || nx * ny !== v.length)
      throw rangeError(
        `Heatmap needs nx x ny cells matching ${v.length} values; pass nx and ny (got ${nx} x ${ny})`,
        'sciviz',
      );
    const dx = rangeOption(options.x, 'Heatmap x') ?? [0, nx - 1],
      dy = rangeOption(options.y, 'Heatmap y') ?? [0, ny - 1],
      fx = this.#forward(0, dx),
      fy = this.#forward(1, dy),
      x: [number, number] = [fx(dx[0]), fx(dx[1])],
      y: [number, number] = [fy(dy[0]), fy(dy[1])];
    if (!x.every(Number.isFinite) || !y.every(Number.isFinite))
      throw rangeError('Heatmap x and y must be above 0 on a log axis', 'sciviz');
    const rects = heatmapRects(v, nx, ny, x, y),
      { colours, swatch } = this.#colours(v.length, v, options, 'heatmap');
    return this.#rects('heatmap', rects, Float32Array.from(v), colours, options.name, swatch);
  }

  #style<L extends ScatterLayer | LineLayer>(
    style: { color: string; colors?: Float32Array; width: number },
    layer: L,
  ): L {
    this.#styles.set(layer, style);
    return this.#add(layer);
  }

  // The elements whose text export paints: tick labels, titles and colour bars.
  #overlayRoots(): Element[] {
    return [
      ...(this.#axes?.elements() ?? []),
      ...[...this.#bars].map((b) => b.element),
      ...(this.#legend && !this.#legend.element.hidden ? [this.#legend.element] : []),
    ];
  }

  /**
   * The figure as a PNG at the canvas's resolution: a fresh frame with the tick labels, titles and colour bars painted
   * over it (`overlays: false` leaves them out). Waits for pending axis updates.
   */
  async toPNG(options: PNGOptions = {}): Promise<Blob> {
    // Export code loads on first use.
    const { paintOverlays, swatches, textRuns } = await import('./export.js');
    await this.#pending;
    this.#check();
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    this.render();
    const bitmap = await createImageBitmap(canvas),
      out = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = out.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    if (options.overlays ?? true) {
      const origin = canvas.getBoundingClientRect(),
        bars = [...this.#bars].map((b) => ({ bar: b.bar, map: b.colormap }));
      paintOverlays(
        g,
        textRuns(this.#overlayRoots(), origin),
        bars,
        origin,
        bitmap.width / (origin.width || bitmap.width),
        swatches(this.#overlayRoots(), origin),
      );
    }
    bitmap.close();
    return out.convertToBlob({ type: 'image/png' });
  }

  /**
   * The figure as SVG in CSS pixels: tick labels, titles and colour bars as text and shapes. A 2D chart whose layers
   * are bars, histograms, heatmaps, lines and scatters of up to 50,000 points is drawn with vector shapes throughout;
   * anything else is a fresh frame embedded as a PNG under the vector text (`vector: false` forces that).
   */
  async toSVG(options: SVGOptions = {}): Promise<string> {
    const ex = await import('./export.js'),
      { base64, svgBars, svgSwatches, svgText, swatches, textRuns } = ex;
    await this.#pending;
    this.#check();
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
      origin = canvas.getBoundingClientRect(),
      { width, height } = this.#canvasSize();
    const vector =
      (options.vector ?? true) &&
      this.#flat &&
      [...this.#layers].every(
        (l) =>
          l instanceof RectsLayer ||
          ('kind' in l && (l.kind === 'line' || (l.kind === 'scatter' && l.count <= 50_000))),
      );
    // A frame places the HTML labels as well as drawing the layers.
    this.render();
    let body: string;
    if (vector) body = this.#vectorSVG(width, height, ex);
    else {
      const bitmap = await createImageBitmap(canvas),
        out = new OffscreenCanvas(bitmap.width, bitmap.height);
      out.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
      body = `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${base64(bytes)}"/>`;
    }
    const bars = svgBars(
        [...this.#bars].map((b) => ({ bar: b.bar, map: b.colormap })),
        origin,
      ),
      text = svgText(textRuns(this.#overlayRoots(), origin)),
      boxes = svgSwatches(swatches(this.#overlayRoots(), origin));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body}\n${bars}\n${boxes}\n${text}\n</svg>\n`;
  }

  // A 2D chart as SVG shapes: background, grid and frame, then rectangles, points and lines in drawing order, clipped
  // to the plot area.
  #vectorSVG(width: number, height: number, { hex, escapeXML }: typeof import('./export.js')): string {
    const m = this.#margin,
      { matrix } = this.#view(),
      p = { x: 0, y: 0, depth: 0, w: 0, inFront: false, inFrustum: false },
      at = (x: number, y: number): [number, number] => {
        projectPoint(matrix, x, y, 0, width, height, 'webgpu', p);
        return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
      };
    const [x0, x1, y0, y1] = this.#bounds,
      pw = width - m.left - m.right,
      ph = height - m.top - m.bottom,
      out: string[] = [
        `<rect width="${width}" height="${height}" fill="${this.theme.background}"/>`,
        `<clipPath id="sciviz-plot"><rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/></clipPath>`,
      ];
    if ((this.#options.grid ?? true) && this.#axes) {
      const grid: string[] = [];
      for (const x of this.#axes.drawnTicks.x) {
        const [sx] = at(x, y0);
        grid.push(`M${sx} ${m.top}V${m.top + ph}`);
      }
      for (const y of this.#axes.drawnTicks.y) {
        const [, sy] = at(x0, y);
        grid.push(`M${m.left} ${sy}H${m.left + pw}`);
      }
      out.push(`<path d="${grid.join('')}" stroke="${this.theme.grid}" stroke-width="1" fill="none"/>`);
    }
    out.push('<g clip-path="url(#sciviz-plot)">');
    const layers = [...this.#layers],
      rgb = (c: number) => hex((c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255);
    for (const layer of layers.filter((l): l is RectsLayer => l instanceof RectsLayer)) {
      const r = layer.rects,
        colours = layer.colours;
      for (let k = 0; k < layer.values.length; k++) {
        if (r[k * 4] === r[k * 4 + 2] && r[k * 4 + 1] === r[k * 4 + 3]) continue;
        const [ax, ay] = at(r[k * 4], r[k * 4 + 3]),
          [bx, by] = at(r[k * 4 + 2], r[k * 4 + 1]);
        out.push(
          `<rect x="${ax}" y="${ay}" width="${Math.round((bx - ax) * 100) / 100}" height="${Math.round((by - ay) * 100) / 100}" fill="${rgb(colours[k])}"/>`,
        );
      }
    }
    for (const layer of layers)
      if ('kind' in layer && layer.kind === 'scatter') {
        const style = this.#styles.get(layer)!,
          pos = layer.positions;
        for (let i = 0; i < layer.count; i++) {
          const [sx, sy] = at(pos[i * 3], pos[i * 3 + 1]),
            c = style.colors;
          const fill = c ? hex(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]) : style.color;
          out.push(`<circle cx="${sx}" cy="${sy}" r="${style.width / 2}" fill="${fill}"/>`);
        }
      }
    for (const layer of layers)
      if ('kind' in layer && layer.kind === 'line') {
        const style = this.#styles.get(layer)!,
          pos = layer.positions,
          n = pos.length / 3,
          c = style.colors;
        const attrs = `stroke-width="${style.width}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
        if (c)
          // Coloured by data: one segment per pair of vertices, in the first vertex's colour.
          for (let i = 0; i + 1 < n; i++) {
            const [ax, ay] = at(pos[i * 3], pos[i * 3 + 1]),
              [bx, by] = at(pos[i * 3 + 3], pos[i * 3 + 4]);
            out.push(
              `<path d="M${ax} ${ay}L${bx} ${by}" stroke="${hex(c[i * 3], c[i * 3 + 1], c[i * 3 + 2])}" ${attrs}/>`,
            );
          }
        else {
          const points = Array.from({ length: n }, (_, i) => at(pos[i * 3], pos[i * 3 + 1]).join(',')).join(' ');
          out.push(`<polyline points="${points}" stroke="${escapeXML(style.color)}" ${attrs}/>`);
        }
      }
    out.push('</g>');
    out.push(
      `<rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}" fill="none" stroke="${this.theme.axis}" stroke-width="1.5"/>`,
    );
    // The window's data range, for tools that read the file.
    out.push(`<desc>x ${x0} to ${x1}, y ${y0} to ${y1}</desc>`);
    return out.join('\n');
  }

  /** A colour bar legend for `colormap` over `range`, at the canvas's right edge. */
  colorbar(colormap: ColormapSource, range: readonly [number, number], options: ColorBarOptions = {}): ColorBar {
    this.#check();
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    const bar = new ColorBar(canvas, resolveColormap(colormap), range, this.theme, options);
    this.#bars.add(bar);
    // Make room for the bar beside a 2D chart unless the margin was chosen.
    if (this.#flat && this.#options.margin?.right === undefined && this.#margin.right < 96)
      this.#margin = { ...this.#margin, right: 96 };
    this.#updateLegend();
    return bar;
  }

  /** Removes a layer and frees it. */
  remove(layer: Layer): void {
    if (!this.#layers.delete(layer)) return;
    if ('kind' in layer && layer.kind === 'scatter') void this.#points?.then((p) => p.remove(layer.cloud));
    else if ('kind' in layer && layer.kind === 'line') void this.#lines?.then((l) => l.remove(layer.line));
    else layer.dispose();
    this.#refit();
    this.#updateLegend();
  }

  /** Frees every layer, the axes and colour bars, and the engine when the figure created it. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const layer of [...this.#layers]) if (!('kind' in layer)) layer.dispose();
    this.#layers.clear();
    for (const bar of this.#bars) bar.dispose();
    this.#axes?.dispose();
    this.#legend?.dispose();
    this.#offFrame?.();
    if (this.#flat) {
      const engine = this.engine as unknown as { views?: unknown; camera: { project?: unknown } };
      if (engine.views === this.#views) engine.views = undefined;
      if (!this.#ownsEngine) engine.camera.project = undefined;
    }
    this.#interaction?.dispose();
    void this.#compute?.then((gpu) => gpu.dispose());
    this.renderer.dispose();
    if (this.#ownsEngine) (this.engine as unknown as Engine).dispose();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Shorthand for `Figure.create(canvas, options)`. */
export const createFigure = (canvas: HTMLCanvasElement, options?: CreateFigureOptions): Promise<Figure> =>
  Figure.create(canvas, options);
