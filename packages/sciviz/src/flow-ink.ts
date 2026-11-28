// Flow ink: fat strokes along pathlines, streaklines and streamlines, coloured by a scalar through OKLab stops, with
// optional highlights that travel downstream (animated evenly spaced streamlines, Jobard and Lefer 2001). Drawn with
// @margoengine/lines, so WebGPU and the WebGL2 compatibility layer draw the same picture. Research: docs/clean-room.md.
import type { EngineKernel } from '@margoengine/core';
import type { Line, Lines } from '@margoengine/lines';
import { fault, rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import { linearToOklab, oklabRamp, oklabToLinear, srgbToLinear, type OklabRamp } from './oklab.js';

/** One stroke of ink. Non-finite points break it; no segment joins across a break. */
export interface FlowInkStroke {
  /** x, y, z per point (`stride` 3), or packed x, y, z, time trace samples (`stride` 4, as `tracePathline` gives). */
  readonly positions: ArrayLike<number>;
  /** 3 or 4 numbers per point. Default 3. */
  readonly stride?: 3 | 4;
  /** A scalar per point (speed, say), coloured through `colors` over `range`. Default none: the stroke takes `color`. */
  readonly values?: ArrayLike<number>;
  /** With `stride` 4: draw only up to this time, the last segment cut where the trace crosses it. Default all. */
  readonly until?: number;
}

/** Travelling highlights along every stroke. Lengths and speeds are in world units (after `matrix` or a figure's model). */
export interface FlowInkPulse {
  /** Highlight length. Positive. Default 0.14. */
  readonly length?: number;
  /** Gap between highlights. Positive. Default 0.2. */
  readonly gap?: number;
  /** Travel speed in world units per second. Finite. Default 0.5. */
  readonly speed?: number;
  /** Extra speed per unit of a stroke's mean value, so faster flow pulses faster. Finite. Default 0. */
  readonly speedPerValue?: number;
  /** Speed classes the strokes are sorted into, one draw each, 1 to 32. Default 8. */
  readonly bands?: number;
  /** Highlight opacity, 0 to 1. Default 1. */
  readonly opacity?: number;
  /** sRGB colour the highlight blends toward in OKLab. Default '#fff3d0'. */
  readonly highlight?: string;
  /** How far toward `highlight`, 0 to 1. Default 0.4. */
  readonly amount?: number;
}

/** Options of {@link flowInk}. */
export interface FlowInkOptions {
  /** OKLab ramp stops for stroke `values`, `#rrggbb` or sRGB [r, g, b]. Default ['#1f4e6b', '#43b7b0', '#f2d58c', '#ee7f5f']. */
  readonly colors?: readonly (string | readonly number[])[];
  /** Value range of the ramp. Default the extent of every stroke's values. */
  readonly range?: readonly [number, number];
  /** sRGB colour of strokes without values. Default '#e8f4ff'. */
  readonly color?: string;
  /** Blend every stroke colour toward this sRGB colour in OKLab. Default none. */
  readonly tint?: string;
  /** How far toward `tint`, 0 to 1. Default 0.4 when `tint` is set. */
  readonly tintAmount?: number;
  /** Width in CSS pixels, positive, at most 64. Default 2. */
  readonly width?: number;
  /** Stroke opacity, 0 to 1. Default 1. */
  readonly opacity?: number;
  /** Travelling highlights over the strokes; `true` takes every default. Default none. */
  readonly pulse?: FlowInkPulse | boolean;
  /** Column-major world matrix of an engine target (a figure supplies its own). Default identity. */
  readonly matrix?: ArrayLike<number>;
  /** Draw over everything, skipping the depth test. Default false. */
  readonly onTop?: boolean;
  /** Pull the ink this fraction of its distance toward the camera, 0 to 1, so it sits over a coplanar surface. Default 0.002. */
  readonly depthBias?: number;
  /** Draw order of the ink's lines plugin. Default 60, after scene meshes and figure layers. */
  readonly order?: number;
  /** The strokes to draw at creation. Default none. */
  readonly strokes?: readonly FlowInkStroke[];
  /** Cancels creation with its exact reason. */
  readonly signal?: AbortSignal;
}

/** One draw of the plan: separate segments (pairs of points), linear rgba per point. */
export interface FlowInkDraw {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  /** null for the steady ink; the highlight travel speed for a pulse band. */
  readonly speed: number | null;
}

const DEFAULT_COLORS = ['#1f4e6b', '#43b7b0', '#f2d58c', '#ee7f5f'];
const GOLDEN = 0.6180339887498949;
const fail = (message: string): never => {
  throw rangeError(message, 'sciviz');
};
const unit = (x: unknown) => typeof x === 'number' && x >= 0 && x <= 1;
const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;

function hex(text: unknown, what: string): [number, number, number] {
  if (typeof text !== 'string' || !/^#[\da-f]{6}$/i.test(text)) fail(`${what} must be #rrggbb`);
  return [1, 3, 5].map((k) => parseInt((text as string).slice(k, k + 2), 16) / 255) as [number, number, number];
}

interface Resolved {
  ramp: OklabRamp;
  range: readonly [number, number] | undefined;
  color: [number, number, number];
  tint: [string, number] | undefined;
  pulse: Required<Omit<FlowInkPulse, 'highlight'>> & { highlight: string } | undefined;
}

function resolve(options: FlowInkOptions): Resolved {
  let ramp: OklabRamp;
  try {
    ramp = oklabRamp(options.colors ?? DEFAULT_COLORS, 'Flow ink');
  } catch (error) {
    return fail((error as Error).message);
  }
  const range = options.range;
  if (range !== undefined && (range.length !== 2 || !range.every(Number.isFinite) || !(range[1] >= range[0])))
    fail('Flow ink range must be two finite ascending numbers');
  const color = hex(options.color ?? '#e8f4ff', 'Flow ink color').map(srgbToLinear) as [number, number, number];
  const tint: [string, number] | undefined =
    options.tint === undefined ? undefined : [options.tint, options.tintAmount ?? 0.4];
  if (tint) hex(tint[0], 'Flow ink tint');
  if (tint && !unit(tint[1])) fail('Flow ink tintAmount must lie in 0 to 1');
  if (options.width !== undefined && (!positive(options.width) || options.width > 64))
    fail('Flow ink width must be positive and at most 64 CSS pixels');
  if (options.opacity !== undefined && !unit(options.opacity)) fail('Flow ink opacity must lie in 0 to 1');
  if (options.depthBias !== undefined && !unit(options.depthBias)) fail('Flow ink depthBias must lie in 0 to 1');
  const p = options.pulse === true ? {} : options.pulse || undefined;
  const pulse = p && {
    length: p.length ?? 0.14,
    gap: p.gap ?? 0.2,
    speed: p.speed ?? 0.5,
    speedPerValue: p.speedPerValue ?? 0,
    bands: p.bands ?? 8,
    opacity: p.opacity ?? 1,
    highlight: p.highlight ?? '#fff3d0',
    amount: p.amount ?? 0.4,
  };
  if (pulse) {
    if (!positive(pulse.length) || !positive(pulse.gap)) fail('Flow ink pulse length and gap must be positive');
    if (!Number.isFinite(pulse.speed) || !Number.isFinite(pulse.speedPerValue)) fail('Flow ink pulse speeds must be finite');
    if (!Number.isInteger(pulse.bands) || pulse.bands < 1 || pulse.bands > 32) fail('Flow ink pulse bands must be 1 to 32');
    if (!unit(pulse.opacity) || !unit(pulse.amount)) fail('Flow ink pulse opacity and amount must lie in 0 to 1');
    hex(pulse.highlight, 'Flow ink pulse highlight');
  }
  return { ramp, range, color, tint, pulse };
}

// Blends linear rgb toward a target sRGB colour in OKLab, by `amount`, so the lightness step stays even.
function blend(target: string, amount: number): (rgb: Float32Array, at: number) => void {
  const [r, g, b] = hex(target, 'Flow ink highlight').map(srgbToLinear),
    end = linearToOklab(r, g, b);
  return (rgb, at) => {
    const lab = linearToOklab(rgb[at], rgb[at + 1], rgb[at + 2]),
      out = oklabToLinear(
        lab[0] + (end[0] - lab[0]) * amount,
        lab[1] + (end[1] - lab[1]) * amount,
        lab[2] + (end[2] - lab[2]) * amount,
      );
    for (let c = 0; c < 3; c++) rgb[at + c] = Math.max(0, out[c]);
  };
}

interface Polyline {
  points: number[];
  values: number[] | null;
}

// A stroke's finite runs, cut at `until` with the crossing interpolated.
function runs(stroke: FlowInkStroke, index: number): Polyline[] {
  const stride = stroke?.stride ?? 3,
    p = stroke?.positions;
  if (stride !== 3 && stride !== 4) fail('Flow ink stroke stride must be 3 or 4');
  if (!p || typeof p.length !== 'number' || p.length % stride) fail(`Flow ink stroke ${index} needs ${stride} numbers per point`);
  const count = p.length / stride,
    values = stroke.values;
  if (values !== undefined && (typeof values?.length !== 'number' || values.length !== count))
    fail(`Flow ink stroke ${index} has ${values?.length} values for ${count} points`);
  const until = stroke.until;
  if (until !== undefined && (stride !== 4 || typeof until !== 'number' || Number.isNaN(until)))
    fail('Flow ink until needs stride 4 trace samples and a time');
  const out: Polyline[] = [];
  let run: Polyline | null = null;
  for (let i = 0; i < count; i++) {
    const k = i * stride,
      x = p[k],
      y = p[k + 1],
      z = p[k + 2],
      v = values ? values[i] : 0;
    const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && (!values || Number.isFinite(v));
    if (!finite) {
      run = null;
      continue;
    }
    if (until !== undefined && p[k + 3] > until) {
      // The previous sample lies before `until`: end the run where the trace crosses it.
      if (run && run.points.length) {
        const j = (i - 1) * stride,
          t0 = p[j + 3],
          t1 = p[k + 3],
          f = t1 > t0 ? (until - t0) / (t1 - t0) : 0;
        if (f > 0) {
          run.points.push(p[j] + (x - p[j]) * f, p[j + 1] + (y - p[j + 1]) * f, p[j + 2] + (z - p[j + 2]) * f);
          const last = run.values;
          if (last && values) last.push(values[i - 1] + (v - values[i - 1]) * f);
        }
      }
      break;
    }
    if (!run) out.push((run = { points: [], values: values ? [] : null }));
    run.points.push(x, y, z);
    run.values?.push(v);
  }
  return out.filter((r) => r.points.length >= 6);
}

/**
 * The draws `FlowInk` makes for `strokes`, on the CPU: one steady draw of every segment, plus one per pulse band with
 * the strokes whose mean value falls in it, each stroke led by an invisible spacer so its highlights start at its own
 * golden-ratio phase. Exposed for tests and for drawing the ink with other line renderers.
 */
export function flowInkDraws(strokes: readonly FlowInkStroke[], options: FlowInkOptions = {}): FlowInkDraw[] {
  if (!Array.isArray(strokes)) fail('Flow ink strokes must be an array');
  const { ramp, range: fixed, color, tint, pulse } = resolve(options);
  const all = strokes.map((s, i) => runs(s, i));
  let lo = fixed?.[0] ?? Infinity,
    hi = fixed?.[1] ?? -Infinity;
  if (!fixed)
    for (const stroke of all)
      for (const run of stroke)
        for (const v of run.values ?? []) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  if (!(lo <= hi)) (lo = 0), (hi = 1);
  const tinted = tint ? blend(tint[0], tint[1]) : null;
  const lit = pulse && pulse.amount > 0 ? blend(pulse.highlight, pulse.amount) : null;
  const colourOf = (run: Polyline, i: number, out: Float32Array, at: number) => {
    if (run.values) ramp.sample(hi > lo ? (run.values[i] - lo) / (hi - lo) : 0, out, at);
    else out.set(color, at);
    tinted?.(out, at);
    out[at + 3] = 1;
  };
  const steady = { positions: [] as number[], colors: [] as number[] };
  const bands = pulse ? Array.from({ length: pulse.bands }, () => ({ positions: [] as number[], colors: [] as number[] })) : [];
  const rgba = new Float32Array(8);
  const period = pulse ? pulse.length + pulse.gap : 0;
  all.forEach((stroke, index) => {
    let sum = 0,
      n = 0;
    for (const run of stroke) for (const v of run.values ?? []) (sum += v), n++;
    const mean = n ? sum / n : lo;
    const band = pulse ? Math.min(pulse.bands - 1, Math.max(0, Math.floor(((mean - lo) / (hi - lo || 1)) * pulse.bands))) : 0;
    const target = bands[band];
    if (target && stroke.length) {
      // The spacer: one invisible segment whose length sets this stroke's phase within the dash period.
      const [x, y, z] = stroke[0].points,
        shift = ((index * GOLDEN) % 1) * period;
      if (shift > 0) target.positions.push(x, y, z, x + shift, y, z), target.colors.push(0, 0, 0, 0, 0, 0, 0, 0);
    }
    for (const run of stroke)
      for (let i = 1; i < run.points.length / 3; i++) {
        steady.positions.push(...run.points.slice(i * 3 - 3, i * 3 + 3));
        colourOf(run, i - 1, rgba, 0);
        colourOf(run, i, rgba, 4);
        steady.colors.push(...rgba);
        if (target) {
          target.positions.push(...run.points.slice(i * 3 - 3, i * 3 + 3));
          lit?.(rgba, 0);
          lit?.(rgba, 4);
          target.colors.push(...rgba);
        }
      }
  });
  const draws: FlowInkDraw[] = [];
  if (steady.positions.length)
    draws.push({ positions: new Float32Array(steady.positions), colors: new Float32Array(steady.colors), speed: null });
  bands.forEach((band, b) => {
    if (!band.positions.length) return;
    const value = lo + ((b + 0.5) / pulse!.bands) * (hi - lo);
    draws.push({
      positions: new Float32Array(band.positions),
      colors: new Float32Array(band.colors),
      speed: pulse!.speed + pulse!.speedPerValue * value,
    });
  });
  return draws;
}

let inks = 0;

/**
 * Strokes of ink along flow traces, a figure layer or a scene object. `set` replaces the strokes, `seek` moves the
 * highlights to a time; neither rebuilds the other. Create with {@link flowInk}.
 */
export class FlowInk {
  visible = true;
  readonly #lines: Lines;
  readonly #Line: typeof Line;
  readonly #options: FlowInkOptions;
  readonly #matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  readonly #detach: () => void;
  #drawn: { line: Line; speed: number | null }[] = [];
  #bounds: Bounds = [0, 0, 0, 0, 0, 0];
  #time = 0;
  #shown = true;
  #disposed = false;

  /** @internal */
  constructor(lines: Lines, LineClass: typeof Line, options: FlowInkOptions, detach: () => void) {
    this.#lines = lines;
    this.#Line = LineClass;
    this.#options = options;
    this.#detach = detach;
    if (options.matrix) {
      if (options.matrix.length !== 16 || !Array.prototype.every.call(options.matrix, Number.isFinite))
        fail('Flow ink matrix must be 16 finite numbers');
      this.#matrix.set(options.matrix);
    }
    resolve(options);
  }

  /** Data bounds of the strokes, for a figure's axes. */
  get bounds(): Bounds {
    return [...this.#bounds] as unknown as Bounds;
  }

  /** Draws (lines) in use: one steady draw plus one per non-empty pulse band. */
  get draws(): number {
    return this.#drawn.length;
  }

  /** Segments drawn by the steady ink. */
  get segments(): number {
    const steady = this.#drawn.find((d) => d.speed === null);
    return steady ? steady.line.segmentCount : 0;
  }

  /** Replaces the strokes. The highlights keep the time of the last `seek`. */
  set(strokes: readonly FlowInkStroke[]): this {
    this.#check();
    const draws = flowInkDraws(strokes, this.#options);
    for (const { line } of this.#drawn) line.dispose();
    this.#drawn = [];
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    const pulse = this.#options.pulse === true ? {} : this.#options.pulse || {};
    for (const draw of draws) {
      if (draw.speed === null)
        for (let i = 0; i < draw.positions.length; i += 3)
          for (let c = 0; c < 3; c++)
            (b[2 * c] = Math.min(b[2 * c], draw.positions[i + c])), (b[2 * c + 1] = Math.max(b[2 * c + 1], draw.positions[i + c]));
      const line = this.#lines.add(
        new this.#Line({
          mode: 'segments',
          positions: draw.positions,
          colors: draw.colors,
          colorMode: 'set',
          width: this.#options.width ?? 2,
          opacity: draw.speed === null ? (this.#options.opacity ?? 1) : (pulse.opacity ?? 1),
          cap: 'round',
          onTop: this.#options.onTop ?? false,
          depthBias: this.#options.depthBias ?? 0.002,
          matrix: this.#matrix,
          ...(draw.speed === null
            ? {}
            : { dashed: true, dashCap: 'round', dashSize: pulse.length ?? 0.14, gapSize: pulse.gap ?? 0.2 }),
        }),
      );
      this.#drawn.push({ line, speed: draw.speed });
    }
    this.#bounds = (b[0] <= b[1] ? b : [0, 0, 0, 0, 0, 0]) as unknown as Bounds;
    this.#apply();
    return this;
  }

  /** Moves every highlight to where it is `seconds` after time zero; any order of times. */
  seek(seconds: number): this {
    this.#check();
    if (!Number.isFinite(seconds)) fail('Flow ink seek needs a finite time');
    this.#time = seconds;
    this.#apply();
    return this;
  }

  /** Shows or hides every stroke (also the `visible` field, read by `seek`, `set` and figures). */
  show(visible: boolean): this {
    this.visible = this.#shown = visible;
    this.#apply();
    return this;
  }

  #apply(): void {
    const pulse = this.#options.pulse === true ? {} : this.#options.pulse || {};
    const period = (pulse.length ?? 0.14) + (pulse.gap ?? 0.2);
    const shown = this.visible && this.#shown;
    for (const { line, speed } of this.#drawn) {
      line.visible = shown;
      if (speed !== null) {
        const offset = -((((speed * this.#time) % period) + period) % period);
        line.material.dashOffset = offset === 0 ? 0 : offset;
      }
    }
  }

  /** @internal A figure's data-to-scene transform. */
  setModel(model: Float32Array): void {
    this.#matrix.set(model);
    for (const { line } of this.#drawn) line.setMatrix(this.#matrix);
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Create a new flow ink after disposal', 'sciviz');
  }

  /** Removes every stroke and the ink's lines plugin; idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { line } of this.#drawn) line.dispose();
    this.#drawn = [];
    this.#detach();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

interface FigureTarget {
  readonly engine: EngineKernel;
  addLayer<L extends { bounds: Bounds; setModel(model: Float32Array): void; dispose(): void }>(layer: L): L;
}

/**
 * Ink strokes on a sciviz `Figure` (a layer in its data units) or on an engine's scene (world units, through
 * `matrix`). Loads @margoengine/lines on first use.
 *
 * ```js
 * const ink = await flowInk(engine, { pulse: { speed: 0.3 } });
 * ink.set([{ positions: [0, 0, 0, 1, 0.2, 0, 2, 0, 0], values: [1, 3, 2] }]);
 * ink.seek(1.5);
 * ```
 */
export async function flowInk(target: FigureTarget | EngineKernel, options: FlowInkOptions = {}): Promise<FlowInk> {
  options.signal?.throwIfAborted();
  resolve(options);
  if (options.order !== undefined && !Number.isFinite(options.order)) fail('Flow ink order must be finite');
  const figure = target && 'addLayer' in target && 'engine' in target ? (target as FigureTarget) : null;
  if (figure && options.matrix) fail('Flow ink on a figure takes the figure transform; leave matrix out');
  const engine = figure ? figure.engine : (target as EngineKernel);
  if (!engine || typeof engine.use !== 'function') fail('Flow ink needs a Figure or an engine');
  const { Lines, Line } = await import('@margoengine/lines');
  options.signal?.throwIfAborted();
  const plugin = new Lines({ name: `flow-ink-${++inks}`, order: options.order ?? 60 });
  engine.use(plugin);
  // Removing the plugin from its scene disposes it and its GPU buffers.
  const detach = () => engine.removePlugin(plugin.name);
  let ink: FlowInk;
  try {
    ink = new FlowInk(plugin, Line, options, detach);
    if (options.strokes) ink.set(options.strokes);
    if (figure) figure.addLayer(ink);
  } catch (error) {
    detach();
    throw error;
  }
  return ink;
}
