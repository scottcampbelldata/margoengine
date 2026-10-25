// Figure: a 3D plot in a Margo Engine canvas. It owns the sciviz renderer, the axes and colour bars, keeps the data
// bounds of its layers (or fixed limits) and maps data units into a box in the scene (data z up), so layers of any
// scale share one frame. Scatter and line layers use @margoengine/points and @margoengine/lines, loaded with import()
// the first time they are used; surfaces, volumes, slices and isosurfaces draw with sciviz's own pipelines.
import { Engine } from '@margoengine/core';
import { hexColor } from '@margoengine/math/color';
import type { EngineKernel } from '@margoengine/core';
import type { ComputeContext } from '@margoengine/compute';
import type { PointCloud, PointsPlugin } from '@margoengine/points';
import type { Line, Lines } from '@margoengine/lines';
import type { OrbitControls } from '@margoengine/controls/orbit';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { Axes, THEMES, type AxesOptions, type Theme } from './axes.js';
import { ColorBar, type ColorBarOptions } from './colorbar.js';
import type { Colormap } from './colormaps.js';
import { Interaction, type DragMode } from './interact.js';
import { IsosurfaceLayer, levelColour, type IsosurfaceLayerOptions } from './isosurface.js';
import { dataToClip, nearestPoint, screenRay, selectPoints, type SelectRegion } from './pick.js';
import { formatValue } from './ticks.js';
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

/** Options for a figure. */
export interface FigureOptions extends AxesOptions {
  /** `'dark'` (default) or `'light'` chrome. */
  readonly theme?: 'dark' | 'light';
  /** Draw axes, grid and tick labels. Default true. */
  readonly axes?: boolean;
  /** Relative size of the plot box (x, y, z). Default [1, 1, 0.75]. */
  readonly aspect?: readonly [number, number, number];
  /** Fixed data limits [xmin, xmax, ymin, ymax, zmin, zmax]. Default: the union of the layers' bounds. */
  readonly limits?: Bounds;
  /** Most scatter points drawn per frame across the figure (level of detail beyond it). Default 2,000,000. */
  readonly pointBudget?: number;
  /** Tooltips on hover: true (default), false, or your own text for a hit (null shows none). */
  readonly tooltips?: boolean | ((hit: PickResult) => string | null);
}

/** What is under the pointer: a scatter point, a line vertex or a point on a surface, in data units. */
export interface PickResult {
  readonly layer: ScatterLayer | LineLayer | SurfaceLayer;
  /** The point's or vertex's index; for a surface, the nearest grid sample (j * nx + i). */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The point's `color` data value, or the surface height. */
  readonly value?: number;
}

/** A finished selection: the indices of the points inside the region, per scatter and line layer. */
export interface Selection {
  readonly region: SelectRegion;
  readonly points: readonly { readonly layer: ScatterLayer | LineLayer; readonly indices: Uint32Array }[];
}

/** The events a figure sends: `hover` when the picked item changes, `selection` when a box or lasso drag ends. */
export interface FigureEventMap {
  hover: CustomEvent<PickResult | null>;
  selection: CustomEvent<Selection>;
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
  /** Positions in data units (x, y, z per point), used for picking and selection. */
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
  /** Vertex positions in data units (x, y, z per vertex), used for picking and selection. */
  readonly positions: Float32Array;
  /** The `color` data, if any. */
  readonly values: ArrayLike<number> | undefined;
  readonly name: string | undefined;
}

/** Any figure layer. */
export type Layer = ScatterLayer | LineLayer | SurfaceLayer | VolumeLayer | IsosurfaceLayer;

const read = async (data: DataSource | undefined): Promise<ArrayLike<number> | undefined> =>
  data === undefined ? undefined : isGpuArray(data) ? await data.read() : data;

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

const boundsOf = (x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number> | undefined): Bounds => {
  const [x0, x1] = extent(x),
    [y0, y1] = extent(y),
    [z0, z1] = z ? extent(z) : [0, 0];
  return [x0, x1, y0, y1, z0, z1];
};

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
  #selection: Selection | undefined;
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
    engine.camera.position = [2.6, 1.7, 2.9];
    engine.camera.target = [0, 0, 0];
    engine.camera.near = 0.01;
    engine.camera.far = 100;
    if (options.controls ?? true) {
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
    if (options.limits) this.#checkBounds(options.limits, 'Figure limits');
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
      });
  }

  #describe(hit: PickResult): string | null {
    const tooltips = this.#options.tooltips ?? true;
    if (typeof tooltips === 'function') return tooltips(hit);
    if (!tooltips) return null;
    const titles = this.#options.titles ?? {},
      name = hit.layer.name,
      lines = [
        `${titles.x ?? 'x'} ${formatValue(hit.x)}`,
        `${titles.y ?? 'y'} ${formatValue(hit.y)}`,
        `${titles.z ?? 'z'} ${formatValue(hit.z)}`,
      ];
    if (hit.value !== undefined && !(hit.layer instanceof SurfaceLayer)) lines.push(`value ${formatValue(hit.value)}`);
    return name ? `${name}\n${lines.join('\n')}` : lines.join('\n');
  }

  /** How a left-button drag on the canvas acts: `'orbit'` (default) moves the camera; `'box'` and `'lasso'` select. */
  get dragMode(): DragMode {
    return this.#interaction?.mode ?? 'orbit';
  }
  set dragMode(mode: DragMode) {
    if (mode !== 'orbit' && mode !== 'box' && mode !== 'lasso')
      throw typeError(`dragMode must be 'orbit', 'box' or 'lasso', got ${String(mode)}`, 'sciviz');
    if (this.#interaction) this.#interaction.mode = mode;
  }

  /** The last selection, or undefined. */
  get selection(): Selection | undefined {
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
        best = { layer, index: i, x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2], value: layer.values?.[i] };
      }
    }
    if (best) return best;
    const ray = screenRay(matrix, width, height, x, y);
    if (!ray) return null;
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
  select(region: SelectRegion): Selection {
    this.#check();
    if (!region || (!('rect' in region) && !('polygon' in region)))
      throw typeError('select takes { rect: [x0, y0, x1, y1] } or { polygon: [x, y, ...] }', 'sciviz');
    const { matrix, width, height } = this.#view();
    const points: { layer: ScatterLayer | LineLayer; indices: Uint32Array }[] = [];
    for (const layer of this.#layers)
      if ('kind' in layer && (layer.kind === 'scatter' || layer.kind === 'line'))
        points.push({ layer, indices: selectPoints(matrix, layer.positions, width, height, region) });
    const selection: Selection = { region, points };
    this.#selection = selection;
    this.dispatchEvent(new CustomEvent('selection', { detail: selection }));
    return selection;
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Figure disposed; create a new one', 'sciviz');
  }

  #checkBounds(b: readonly number[], what: string): void {
    if (b.length !== 6 || !b.every(Number.isFinite) || b[1] < b[0] || b[3] < b[2] || b[5] < b[4])
      throw rangeError(
        `${what} must be [xmin, xmax, ymin, ymax, zmin, zmax] with finite numbers, each min <= max`,
        'sciviz',
      );
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
    let b: Bounds | undefined = this.#options.limits ? ([...this.#options.limits] as Bounds) : undefined;
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
    this.#bounds = b ?? [-1, 1, -1, 1, -1, 1];
    this.#model = dataToScene(this.#bounds, this.#options.aspect ?? [1, 1, 0.75]);
    for (const layer of this.#layers) {
      if ('kind' in layer && layer.kind === 'scatter') layer.cloud.matrix.set(this.#model);
      else if ('kind' in layer && layer.kind === 'line') layer.line.setMatrix(this.#model);
      else layer.setModel(this.#model);
    }
    if (this.#axes) this.#pending = this.#pending.then(() => this.#axes!.update(this.#bounds, this.#model));
  }

  #add<L extends Layer>(layer: L): L {
    this.#layers.add(layer);
    this.#refit();
    return layer;
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
      positions = p instanceof Float32Array ? p : Float32Array.from(p);
      const xs = new Float32Array(p.length / 3),
        ys = new Float32Array(p.length / 3),
        zs = new Float32Array(p.length / 3);
      for (let i = 0; i < xs.length; i++) [xs[i], ys[i], zs[i]] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
      bounds = boundsOf(xs, ys, zs);
    } else {
      const [x, y, z] = await Promise.all([read(data.x), read(data.y), read(data.z)]);
      if (!x || !y || x.length !== y.length || (z && z.length !== x.length))
        throw rangeError('scatter x, y and z must have one length', 'sciviz');
      positions = new Float32Array(x.length * 3);
      for (let i = 0; i < x.length; i++) {
        positions[i * 3] = x[i];
        positions[i * 3 + 1] = y[i];
        positions[i * 3 + 2] = z ? z[i] : 0;
      }
      bounds = boundsOf(x, y, z);
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
    const uniform = options.color ? hexRGB(options.color, 'scatter color') : map.sample(0.6);
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
    return this.#add({ kind: 'scatter', cloud, bounds, count, positions, values: colourData, name: options.name });
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
    const positions = new Float32Array(x.length * 3);
    for (let i = 0; i < x.length; i++)
      [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] = [x[i], y[i], z ? z[i] : 0];
    const map = resolveColormap(options.colormap);
    if (c && c.length !== x.length)
      throw rangeError(`line color has ${c.length} values for ${x.length} points`, 'sciviz');
    const colours = c ? mapColours(c, map, rangeOption(options.range, 'line range') ?? extent(c)) : undefined;
    const lines = await this.#linesPlugin();
    const { Line } = await import('@margoengine/lines');
    this.#check();
    const colour =
      options.color ??
      `#${map
        .sample(0.6)
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
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
    return this.#add({ kind: 'line', line, bounds: boundsOf(x, y, z), positions, values: c, name: options.name });
  }

  /** A surface plot of heights `z` over a grid (`nx` columns; a GpuArray of shape [ny, nx] is read in place). */
  surface(z: DataSource, options: SurfaceLayerOptions = {}): SurfaceLayer {
    this.#check();
    const layer = new SurfaceLayer(this.renderer, z, options);
    this.renderer.add(layer);
    return this.#add(layer);
  }

  /** A volume rendering of a 3D grid (x fastest; a GpuArray of shape [nz, ny, nx] is uploaded on the GPU). */
  volume(data: DataSource, options: VolumeLayerOptions = {}): VolumeLayer {
    this.#check();
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

  /** A colour bar legend for `colormap` over `range`, at the canvas's right edge. */
  colorbar(colormap: ColormapSource, range: readonly [number, number], options: ColorBarOptions = {}): ColorBar {
    this.#check();
    const canvas = (this.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    const bar = new ColorBar(canvas, resolveColormap(colormap), range, this.theme, options);
    this.#bars.add(bar);
    return bar;
  }

  /** Removes a layer and frees it. */
  remove(layer: Layer): void {
    if (!this.#layers.delete(layer)) return;
    if ('kind' in layer && layer.kind === 'scatter') void this.#points?.then((p) => p.remove(layer.cloud));
    else if ('kind' in layer && layer.kind === 'line') void this.#lines?.then((l) => l.remove(layer.line));
    else layer.dispose();
    this.#refit();
  }

  /** Frees every layer, the axes and colour bars, and the engine when the figure created it. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const layer of [...this.#layers]) if (!('kind' in layer)) layer.dispose();
    this.#layers.clear();
    for (const bar of this.#bars) bar.dispose();
    this.#axes?.dispose();
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
