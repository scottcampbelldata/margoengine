/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure, FigureOptions, CreateFigureOptions, Layer } from './figure.js';
import {
  FilterPipeline,
  type PipelineJSON,
  type PipelineRegistry,
  type PipelineValue,
} from '@margoengine/sciviz/pipeline';
import { linkCameras, type LinkedCameras, type LinkedCameraOptions } from './views-link.js';
import { volumeSlice, validateViewVolume, clampCrosshair } from './views-math.js';
import type { ColormapSource } from './layer.js';
import type { PickVolume, AnnotationPoint, Annotation } from './annotate-math.js';
import type { Annotations } from './annotate.js';
import type { SliceLayer } from './volume.js';
import { dataToClip, screenRay } from './pick.js';
export { LinkedCameras, linkCameras, type LinkedCameraOptions } from './views-link.js';
export { volumeSlice, type VolumeSlice } from './views-math.js';

/** Creation and accessible CSS-grid layout options. Each view has its own engine/canvas. */
export interface FigureLayoutOptions {
  /** Default ceil(sqrt(view count)). */
  readonly columns?: number;
  /** Cell height in CSS pixels, default 320. */
  readonly height?: number;
  /** Gap in CSS pixels, default 12. */
  readonly gap?: number;
  /** Optional visible headings and accessible canvas names. */
  readonly labels?: readonly string[];
  /** Options per figure; default empty options. */
  readonly figureOptions?: (index: number) => FigureOptions;
  /** Default the root Figure.create factory, loaded only on create. */
  readonly createFigure?: (canvas: HTMLCanvasElement, options: CreateFigureOptions, index: number) => Promise<Figure>;
  /** Cancels creation and disposes an existing layout. */
  readonly signal?: AbortSignal;
}
/** Owned figures in an accessible, resizable layout. No import-time DOM work. */
export class FigureLayout {
  readonly element: HTMLDivElement;
  readonly figures: readonly Figure[];
  readonly canvases: readonly HTMLCanvasElement[];
  readonly #abort: () => void;
  #dead = false;
  private constructor(element: HTMLDivElement, figures: Figure[], canvases: HTMLCanvasElement[], signal?: AbortSignal) {
    this.element = element;
    this.figures = Object.freeze(figures);
    this.canvases = Object.freeze(canvases);
    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    this.#abort = () => signal?.removeEventListener('abort', abort);
  }
  /** Create all figures transactionally; failed or aborted creation disposes every completed engine. */
  static async create(container: HTMLElement, count: number, options: FigureLayoutOptions = {}): Promise<FigureLayout> {
    options.signal?.throwIfAborted();
    const columns = options.columns ?? Math.ceil(Math.sqrt(count)),
      height = options.height ?? 320,
      gap = options.gap ?? 12;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(columns) ||
      columns < 1 ||
      !Number.isFinite(height) ||
      height <= 0 ||
      !Number.isFinite(gap) ||
      gap < 0 ||
      (options.labels && options.labels.length !== count)
    )
      throw rangeError(
        'Layout needs a positive view count, columns and height, nonnegative gap and one label per view',
        'sciviz',
      );
    const element = document.createElement('div');
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Linked figure layout');
    element.style.cssText = `display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:${gap}px`;
    container.append(element);
    const figures: Figure[] = [],
      canvases: HTMLCanvasElement[] = [];
    try {
      const factory =
        options.createFigure ??
        (async (canvas, opts) => {
          const { Figure } = await import('@margoengine/sciviz');
          return Figure.create(canvas, opts);
        });
      for (let i = 0; i < count; i++) {
        options.signal?.throwIfAborted();
        const cell = document.createElement('section');
        cell.style.cssText = 'position:relative;min-width:0';
        const label = options.labels?.[i] ?? `View ${i + 1}`,
          heading = document.createElement('h3');
        heading.textContent = label;
        heading.style.cssText = 'font:inherit;margin:0 0 6px';
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `display:block;width:100%;height:${height}px`;
        canvas.setAttribute('aria-label', label);
        canvas.tabIndex = 0;
        cell.append(heading, canvas);
        element.append(cell);
        canvases.push(canvas);
        figures.push(await factory(canvas, { ...options.figureOptions?.(i), signal: options.signal }, i));
        options.signal?.throwIfAborted();
      }
      return new FigureLayout(element, figures, canvases, options.signal);
    } catch (error) {
      for (const figure of figures) figure.dispose();
      element.remove();
      throw error;
    }
  }
  /** Dispose every owned figure and remove only this layout's DOM. Idempotent. */
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#abort();
    for (const f of this.figures) f.dispose();
    this.element.remove();
  }
  /** Enable explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** One cell runs the same graph with a time and optional node-parameter replacements. */
export interface ComparisonCell {
  readonly label?: string;
  /** Default 0. */
  readonly time?: number;
  /** Complete replacement params keyed by pipeline node ID; default no overrides. */
  readonly params?: Readonly<Record<string, PipelineValue>>;
}
/** A graph result is drawn using the same callback for each comparative cell. */
export interface ComparativeGridOptions extends FigureLayoutOptions {
  readonly cells: readonly ComparisonCell[];
  readonly target: string;
  readonly draw: (
    figure: Figure,
    output: unknown,
    cell: ComparisonCell,
    index: number,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Default true. Link 2D ranges or 3D cameras after all cells have drawn. */
  readonly linked?: boolean | LinkedCameraOptions;
}
/** One portable pipeline, independently evaluated across time steps or parameter values. */
export class ComparativeGrid {
  readonly layout: FigureLayout;
  readonly pipelines: readonly FilterPipeline[];
  readonly outputs: readonly unknown[];
  readonly link?: LinkedCameras;
  readonly #abort: AbortController;
  readonly #off: () => void;
  #dead = false;
  private constructor(
    layout: FigureLayout,
    pipelines: FilterPipeline[],
    outputs: unknown[],
    abort: AbortController,
    link: LinkedCameras | undefined,
    signal?: AbortSignal,
  ) {
    this.layout = layout;
    this.pipelines = Object.freeze(pipelines);
    this.outputs = Object.freeze(outputs);
    this.#abort = abort;
    this.link = link;
    const dispose = () => this.dispose();
    signal?.addEventListener('abort', dispose, { once: true });
    this.#off = () => signal?.removeEventListener('abort', dispose);
  }
  /** Create a complete comparison. Any failed cell releases graphs, outputs and figures. */
  static async create(
    container: HTMLElement,
    definition: PipelineJSON,
    registry: PipelineRegistry,
    options: ComparativeGridOptions,
  ): Promise<ComparativeGrid> {
    options.signal?.throwIfAborted();
    if (!options.cells.length || options.cells.some((c) => c.time !== undefined && !Number.isFinite(c.time)))
      throw rangeError('Comparison needs cells with finite times', 'sciviz');
    const abort = new AbortController(),
      signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
    const pipelines: FilterPipeline[] = [],
      outputs: unknown[] = [];
    const layout = await FigureLayout.create(container, options.cells.length, {
      ...options,
      signal,
      labels: options.labels ?? options.cells.map((c, i) => c.label ?? `Comparison ${i + 1}`),
    });
    try {
      for (const [i, cell] of options.cells.entries()) {
        signal.throwIfAborted();
        const pipeline = FilterPipeline.fromJSON(definition, registry);
        pipelines.push(pipeline);
        for (const [id, params] of Object.entries(cell.params ?? {})) pipeline.setParams(id, params);
        const output = await pipeline.run(options.target, { time: cell.time ?? 0, signal });
        outputs.push(output);
        await options.draw(layout.figures[i], output, cell, i, signal);
        await layout.figures[i].ready();
        signal.throwIfAborted();
      }
      const link =
        options.linked !== false && layout.figures.length > 1
          ? linkCameras(layout.figures, { ...(typeof options.linked === 'object' ? options.linked : {}), signal })
          : undefined;
      link?.sync();
      return new ComparativeGrid(layout, pipelines, outputs, abort, link, options.signal);
    } catch (error) {
      abort.abort(error);
      for (const p of pipelines) p.dispose();
      layout.dispose();
      throw error;
    }
  }
  /** Cancel pending work and release graph outputs before disposing the figures. */
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#off();
    this.#abort.abort();
    this.link?.dispose();
    for (const p of this.pipelines) p.dispose();
    this.layout.dispose();
  }
  /** Enable explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Orthogonal nearest-sample slices and a 3D volume share one physical crosshair. */
export interface VolumeQuadOptions extends FigureLayoutOptions {
  /** Initial physical crosshair, default the volume centre. Coordinates clamp and snap to the nearest sample centre. */
  readonly crosshair?: AnnotationPoint;
  /** Colour range, default finite sample extent. */
  readonly range?: readonly [number, number];
  /** Default gray. */
  readonly colormap?: ColormapSource;
}
/** Three orthographic slice figures plus a 3D volume with the same planes and crosshair. */
export class VolumeQuad extends EventTarget {
  readonly layout: FigureLayout;
  readonly volume: PickVolume;
  readonly #bounds: readonly number[];
  readonly #annotations: Annotations[];
  readonly #planes: SliceLayer[];
  readonly #heatmaps: (Layer | undefined)[] = [];
  readonly #events = new AbortController();
  readonly #resize: ResizeObserver;
  #resizeFrame = 0;
  readonly #sizes: ({ width: number; height: number } | undefined)[] = [];
  readonly #options: VolumeQuadOptions;
  #position: AnnotationPoint;
  #queue: Promise<void> = Promise.resolve();
  #last: Promise<void> = this.#queue;
  #dead = false;
  private constructor(
    layout: FigureLayout,
    volume: PickVolume,
    bounds: readonly number[],
    annotations: Annotations[],
    planes: SliceLayer[],
    options: VolumeQuadOptions,
  ) {
    super();
    this.layout = layout;
    this.volume = volume;
    this.#bounds = bounds;
    this.#annotations = annotations;
    this.#planes = planes;
    this.#options = options;
    this.#position = clampCrosshair(
      bounds,
      options.crosshair ?? ([0, 1, 2].map((i) => (bounds[2 * i] + bounds[2 * i + 1]) / 2) as [number, number, number]),
    );
    for (let axis = 0; axis < 3; axis++) {
      const canvas = layout.canvases[axis],
        figure = layout.figures[axis],
        axes = [0, 1, 2].filter((a) => a !== axis);
      canvas.addEventListener(
        'click',
        (event) => {
          const r = canvas.getBoundingClientRect(),
            ray = screenRay(
              dataToClip(figure.engine.camera.matrix, figure.model),
              r.width,
              r.height,
              event.clientX - r.left,
              event.clientY - r.top,
            );
          if (!ray || ray.direction[2] === 0) return;
          const t = -ray.origin[2] / ray.direction[2],
            p = [...this.#position] as [number, number, number];
          p[axes[0]] = ray.origin[0] + t * ray.direction[0];
          p[axes[1]] = ray.origin[1] + t * ray.direction[1];
          void this.setCrosshair(p).catch((error) => this.dispatchEvent(new CustomEvent('error', { detail: error })));
        },
        { signal: this.#events.signal },
      );
    }
    // Refit and draw on the next frame, never inside the delivery: drawing can resize the canvases this observes,
    // which WebKit reports as a ResizeObserver loop (KB6438a). Deliveries before that frame share one redraw.
    this.#resize = new ResizeObserver(() => {
      if (this.#resizeFrame) return;
      this.#resizeFrame = requestAnimationFrame(() => {
        this.#resizeFrame = 0;
        if (this.#dead || this.#heatmaps.filter(Boolean).length !== 3) return;
        this.#fitSlices(true);
        for (let i = 0; i < 3; i++) {
          this.layout.figures[i].render();
          this.#annotations[i].render();
        }
      });
    });
    for (const canvas of layout.canvases.slice(0, 3)) this.#resize.observe(canvas);
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal: this.#events.signal });
  }
  // Equal physical distances occupy equal screen distances. On resize retain the current zoom and centre.
  #fitSlices(resize = false): void {
    for (let axis = 0; axis < 3; axis++) {
      if (!resize && this.#sizes[axis]) continue;
      const figure = this.layout.figures[axis],
        area = figure.plotArea,
        previous = this.#sizes[axis];
      if (area.width <= 0 || area.height <= 0) continue;
      const axes = [0, 1, 2].filter((i) => i !== axis),
        b = this.#bounds,
        d = this.volume.dims;
      const x0 = Math.min(b[2 * axes[0]], b[2 * axes[0] + 1]),
        x1 = Math.max(b[2 * axes[0]], b[2 * axes[0] + 1]),
        y0 = Math.min(b[2 * axes[1]], b[2 * axes[1] + 1]),
        y1 = Math.max(b[2 * axes[1]], b[2 * axes[1] + 1]);
      const current = figure.bounds,
        unit = previous
          ? (current[3] - current[2]) / previous.height
          : Math.max(
              ((x1 - x0) * d[axes[0]]) / (d[axes[0]] - 1) / area.width,
              ((y1 - y0) * d[axes[1]]) / (d[axes[1]] - 1) / area.height,
            );
      const cx = previous ? (current[0] + current[1]) / 2 : (x0 + x1) / 2,
        cy = previous ? (current[2] + current[3]) / 2 : (y0 + y1) / 2;
      figure.setLimits([
        cx - (unit * area.width) / 2,
        cx + (unit * area.width) / 2,
        cy - (unit * area.height) / 2,
        cy + (unit * area.height) / 2,
      ]);
      this.#sizes[axis] = { width: area.width, height: area.height };
    }
  }
  /** Create four owned figures and a complete initial set of linked slices. */
  static async create(
    container: HTMLElement,
    volume: PickVolume,
    options: VolumeQuadOptions = {},
  ): Promise<VolumeQuad> {
    options.signal?.throwIfAborted();
    const bounds = [...validateViewVolume(volume)];
    const position = clampCrosshair(
      bounds,
      options.crosshair ?? ([0, 1, 2].map((i) => (bounds[2 * i] + bounds[2 * i + 1]) / 2) as [number, number, number]),
    );
    const layout = await FigureLayout.create(container, 4, {
      ...options,
      columns: options.columns ?? 2,
      labels: options.labels ?? ['Sagittal (x)', 'Coronal (y)', 'Axial (z)', '3D volume'],
      figureOptions: (i) => ({
        ...options.figureOptions?.(i),
        ...(i < 3 ? { mode: '2d' as const, axes: false } : { mode: '3d' as const, axes: false }),
      }),
    });
    try {
      const { annotate } = await import('@margoengine/sciviz/annotate'),
        annotations = layout.figures.map((f) => annotate(f, { editable: false }));
      const layer = layout.figures[3].volume(volume.data, {
        dims: volume.dims,
        bounds: bounds as [number, number, number, number, number, number],
        range: options.range,
        colormap: options.colormap ?? 'gray',
        density: 0.15,
      });
      const planes = (['x', 'y', 'z'] as const).map((a, i) =>
        layer.slice(a, (position[i] - bounds[i * 2]) / (bounds[i * 2 + 1] - bounds[i * 2]), { opacity: 0.75 }),
      );
      const quad = new VolumeQuad(layout, volume, bounds, annotations, planes, { ...options, range: layer.range });
      await quad.setCrosshair(position);
      options.signal?.throwIfAborted();
      return quad;
    } catch (error) {
      layout.dispose();
      throw error;
    }
  }
  /** Snapshot of the shared physical crosshair; external mutation cannot change the views. */
  get crosshair(): AnnotationPoint {
    return [...this.#position] as [number, number, number];
  }
  /** Snap physical coordinates to voxel centres and redraw all planes in order. Resolves after every view is ready. */
  setCrosshair(position: AnnotationPoint, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.#dead) return Promise.reject(fault('disposed', 'Volume quad disposed; create another layout', 'sciviz'));
    const clamped = clampCrosshair(this.#bounds, position),
      b = this.#bounds;
    const next = clamped.map((v, i) => {
      const n = this.volume.dims[i] - 1;
      return b[2 * i] + (Math.round(((v - b[2 * i]) / (b[2 * i + 1] - b[2 * i])) * n) * (b[2 * i + 1] - b[2 * i])) / n;
    }) as [number, number, number];
    const work = async () => {
      options.signal?.throwIfAborted();
      if (this.#dead) throw fault('disposed', 'Volume quad disposed; create another layout', 'sciviz');
      this.#options.signal?.throwIfAborted();
      const b = this.#bounds;
      const prepared: { slice: ReturnType<typeof volumeSlice>; layer: Awaited<ReturnType<Figure['heatmap']>> }[] = [];
      try {
        for (let axis = 0; axis < 3; axis++) {
          options.signal?.throwIfAborted();
          const slice = volumeSlice(this.volume, (['x', 'y', 'z'] as const)[axis], next[axis]),
            figure = this.layout.figures[axis];
          const layer = await figure.heatmap(slice.data, {
            nx: slice.nx,
            ny: slice.ny,
            x: slice.x,
            y: slice.y,
            range: this.#options.range,
            colormap: this.#options.colormap ?? 'gray',
          });
          layer.visible = false;
          prepared.push({ slice, layer });
          if (this.#dead)
            throw fault('disposed', 'Volume quad disposed during slice creation; create another layout', 'sciviz');
        }
        await Promise.all(this.layout.figures.map((f) => f.ready()));
        options.signal?.throwIfAborted();
        if (this.#dead)
          throw fault('disposed', 'Volume quad disposed before slice publication; create another layout', 'sciviz');
      } catch (error) {
        if (!this.#dead) for (let i = 0; i < prepared.length; i++) this.layout.figures[i].remove(prepared[i].layer);
        throw error;
      }
      for (let axis = 0; axis < 3; axis++) {
        const { slice, layer } = prepared[axis],
          figure = this.layout.figures[axis],
          prior = this.#heatmaps[axis];
        if (prior) figure.remove(prior);
        layer.visible = true;
        this.#heatmaps[axis] = layer;
        const [x, y] = slice.axes,
          records: Annotation[] = [
            {
              id: 'horizontal',
              kind: 'line',
              points: [
                [b[x * 2], next[y], 0],
                [b[x * 2 + 1], next[y], 0],
              ],
              color: '#5ed7ff',
            },
            {
              id: 'vertical',
              kind: 'line',
              points: [
                [next[x], b[y * 2], 0],
                [next[x], b[y * 2 + 1], 0],
              ],
              color: '#ffd166',
            },
          ];
        this.#annotations[axis].restore(records);
        this.#planes[axis].position = (next[axis] - b[axis * 2]) / (b[axis * 2 + 1] - b[axis * 2]);
      }
      this.#fitSlices();
      this.#annotations[3].restore(
        [0, 1, 2].map((axis) => {
          const p = [...next] as [number, number, number],
            q = [...next] as [number, number, number];
          p[axis] = b[axis * 2];
          q[axis] = b[axis * 2 + 1];
          return { id: `axis-${axis}`, kind: 'line', points: [p, q], color: ['#ff7f7f', '#5ed7ff', '#ffd166'][axis] };
        }),
      );
      await Promise.all(this.layout.figures.map((f) => f.ready()));
      if (this.#dead) throw fault('disposed', 'Volume quad disposed; create another layout', 'sciviz');
      this.#position = next;
      for (let i = 0; i < 4; i++) {
        this.layout.figures[i].render();
        this.#annotations[i].render();
      }
      this.dispatchEvent(new CustomEvent('change', { detail: { position: this.crosshair } }));
    };
    const result = this.#queue.then(work);
    this.#last = result;
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** Wait for the last queued crosshair update, including its errors; abort cancels this wait only. */
  ready(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.#last;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.#last.then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  /** Remove interaction, annotations, slices and all four owned figures. Idempotent. */
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#events.abort();
    this.#resize.disconnect();
    cancelAnimationFrame(this.#resizeFrame);
    this.layout.dispose();
  }
  /** Enable explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
