// Clean room from Kniss, Kindlmann and Hansen (2002) and Engel, Kraus and Ertl (2001).
import { rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import type { VolumeLayer, VolumeClassification } from './volume.js';
export { transferEditor } from './transfer-editor.js';
export type { TransferEditor, TransferEditorOptions } from './transfer-editor.js';

/** Linear-light red, green, blue and reference-voxel opacity, each in [0,1]. */
export type TransferRGBA = readonly [number, number, number, number];
/** A physical scalar value and its linear-light RGBA classification. */
export interface TransferPoint {
  /** Physical scalar value. */
  readonly value: number;
  /** Linear-light colour and reference-voxel opacity. */
  readonly rgba: TransferRGBA;
}
/** A widget in physical scalar-value / gradient-magnitude space. */
export type TransferWidget = {
  /** Linear-light colour and peak opacity. */
  readonly rgba: TransferRGBA;
} & (
  | {
      /** Axis-aligned constant classification. */ readonly kind: 'rectangle' /** [value0,value1,gradient0,gradient1]. */;
      readonly bounds: Bounds2D;
    }
  | {
      /** Barycentric tent, zero on the boundary. */ readonly kind: 'triangle' /** Three [value,gradient] vertices. */;
      readonly vertices: readonly [Point2D, Point2D, Point2D];
    }
  | {
      /** Elliptical Gaussian with standard deviations sigma. */ readonly kind: 'gaussian' /** [value,gradient]. */;
      readonly center: Point2D /** Positive standard deviations. */;
      readonly sigma: Point2D;
    }
);
/** [value, gradient magnitude]. */
export type Point2D = readonly [number, number];
/** [value0,value1,gradient0,gradient1]. */
export type Bounds2D = readonly [number, number, number, number];
/** Serializable, owned transfer function state. */
export interface TransferState {
  /** 1D uses points; 2D composites widgets in array order, first in front. Default '1d'. */
  readonly mode?: '1d' | '2d';
  /** Physical scalar domain. */
  readonly range: readonly [number, number];
  /** Positive upper bound of the gradient axis, scalar units per data unit. */
  readonly gradientMax: number;
  /** Strictly increasing scalar points, at least two. */
  readonly points: readonly TransferPoint[];
  /** Classification widgets. Default empty. */
  readonly widgets?: readonly TransferWidget[];
}

const finite = (a: readonly number[]) => a.every(Number.isFinite);
function checked(state: TransferState): TransferState {
  const s = structuredClone(state);
  if (
    !s.range ||
    s.range.length !== 2 ||
    !finite(s.range) ||
    !(s.range[1] > s.range[0]) ||
    !(s.gradientMax > 0) ||
    !Number.isFinite(s.gradientMax) ||
    !['1d', '2d'].includes(s.mode ?? '1d')
  )
    throw rangeError(
      'Transfer needs an increasing finite range and positive gradientMax; correct the domain',
      'sciviz',
    );
  const colour = (c: TransferRGBA) => c?.length === 4 && finite(c) && c.every((v) => v >= 0 && v <= 1);
  if (
    !Array.isArray(s.points) ||
    s.points.length < 2 ||
    s.points.some((p, i) => !Number.isFinite(p.value) || !colour(p.rgba) || (i > 0 && p.value <= s.points[i - 1].value))
  )
    throw rangeError(
      'Transfer points need increasing values and four colour channels in [0,1]; correct the points',
      'sciviz',
    );
  for (const w of s.widgets ?? []) {
    let ok = colour(w.rgba);
    if (w.kind === 'rectangle')
      ok &&=
        w.bounds?.length === 4 &&
        finite(w.bounds) &&
        w.bounds[1] > w.bounds[0] &&
        w.bounds[3] > w.bounds[2] &&
        w.bounds[2] >= 0;
    else if (w.kind === 'gaussian')
      ok &&=
        w.center?.length === 2 &&
        finite(w.center) &&
        w.center[1] >= 0 &&
        w.sigma?.length === 2 &&
        finite(w.sigma) &&
        w.sigma.every((x) => x > 0);
    else if (w.kind === 'triangle')
      ok &&=
        w.vertices?.length === 3 &&
        w.vertices.every((p) => p.length === 2 && finite(p) && p[1] >= 0) &&
        Math.abs(area(...w.vertices)) > 0;
    else ok = false;
    if (!ok)
      throw rangeError(
        'Transfer widget has invalid geometry or RGBA; use a nondegenerate widget in value/gradient units',
        'sciviz',
      );
  }
  return s;
}
const area = (a: Point2D, b: Point2D, c: Point2D) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function evaluate(s: TransferState, value: number, gradient: number): TransferRGBA {
  if (s.mode !== '2d') {
    const p = s.points;
    if (value <= p[0].value) return p[0].rgba;
    for (let i = 1; i < p.length; i++)
      if (value <= p[i].value) {
        const t = (value - p[i - 1].value) / (p[i].value - p[i - 1].value);
        return p[i].rgba.map((v, c) => p[i - 1].rgba[c] + (v - p[i - 1].rgba[c]) * t) as unknown as TransferRGBA;
      }
    return p[p.length - 1].rgba;
  }
  const out = [0, 0, 0, 0];
  for (const w of s.widgets ?? []) {
    let weight = 0;
    if (w.kind === 'rectangle') {
      const b = w.bounds;
      weight = +(value >= b[0] && value <= b[1] && gradient >= b[2] && gradient <= b[3]);
    } else if (w.kind === 'gaussian')
      weight = Math.exp(
        -0.5 * (((value - w.center[0]) / w.sigma[0]) ** 2 + ((gradient - w.center[1]) / w.sigma[1]) ** 2),
      );
    else {
      const [a, b, c] = w.vertices,
        p: Point2D = [value, gradient],
        determinant = area(a, b, c);
      weight = Math.max(
        0,
        Math.min(area(p, b, c) / determinant, area(a, p, c) / determinant, area(a, b, p) / determinant) * 3,
      );
    }
    const opacity = (1 - out[3]) * w.rgba[3] * weight;
    for (let c = 0; c < 3; c++) out[c] += opacity * w.rgba[c];
    out[3] += opacity;
  }
  if (out[3]) for (let c = 0; c < 3; c++) out[c] /= out[3];
  return out as unknown as TransferRGBA;
}

/** Editable classifier. Change events fire synchronously after each validated, atomic update. No DOM is required. */
export class TransferFunction extends EventTarget {
  #state: TransferState;
  /** Snapshot a state. */
  constructor(state: TransferState) {
    super();
    this.#state = checked(state);
  }
  /** Owned serializable snapshot. Editing it does not mutate this function. */
  get state(): TransferState {
    return structuredClone(this.#state);
  }
  /** Replace state atomically and emit 'change'. */
  update(state: TransferState): void {
    const next = checked(state);
    this.#state = next;
    this.dispatchEvent(new Event('change'));
  }
  /** Evaluate in physical scalar / gradient units. Out-of-range 1D values clamp to endpoint colours. */
  evaluate(value: number, gradient = 0): TransferRGBA {
    if (!finite([value, gradient]) || gradient < 0)
      throw rangeError('Evaluation needs a finite scalar and nonnegative gradient; correct the sample', 'sciviz');
    return [...evaluate(this.#state, value, gradient)];
  }
  /** Rasterize a 2D classifier, including a 1D function repeated over gradients. Default resolution 256. */
  table(resolution = 256, range: readonly [number, number] = this.#state.range): VolumeClassification {
    size(resolution);
    if (range.length !== 2 || !finite(range) || range[1] <= range[0])
      throw rangeError('Transfer table needs an increasing finite range; correct the domain', 'sciviz');
    const rgba = new Uint8Array(resolution ** 2 * 4),
      s = this.#state;
    for (let y = 0; y < resolution; y++)
      for (let x = 0; x < resolution; x++) {
        const c = evaluate(
          s,
          range[0] + (x / (resolution - 1)) * (range[1] - range[0]),
          (y / (resolution - 1)) * s.gradientMax,
        );
        c.forEach((v, k) => {
          rgba[(y * resolution + x) * 4 + k] = Math.round(v * 255);
        });
      }
    return { kind: 'gradient', size: [resolution, resolution], rgba, gradientMax: s.gradientMax };
  }
}

function size(n: number): void {
  if (!Number.isInteger(n) || n < 2 || n > 2048)
    throw rangeError('Transfer resolution must be an integer 2..2048; choose a supported resolution', 'sciviz');
}

/** Numerical emission/absorption integral for each ordered front/back scalar pair. */
export async function preintegrateTransfer(
  tf: TransferFunction,
  options: {
    /** Table resolution. Default 128. */ readonly resolution?: number;
    /** Midpoint quadrature samples per segment. Default 128, 8..2048. */ readonly samples?: number;
    /** Segment length in reference voxels. Default 1. */ readonly step?: number;
    /** Optical density. Default 1. */ readonly density?: number;
    /** Scalar range the table spans; pass the layer's `range`. Default the function's range. */
    readonly range?: readonly [number, number];
    /** Cancels generation with the exact reason. */ readonly signal?: AbortSignal;
  } = {},
): Promise<VolumeClassification> {
  const s = tf.state,
    range = options.range ?? s.range,
    n = options.resolution ?? 128,
    samples = options.samples ?? 128,
    step = options.step ?? 1,
    density = options.density ?? 1;
  size(n);
  if (
    s.mode === '2d' ||
    !Number.isInteger(samples) ||
    samples < 8 ||
    samples > 2048 ||
    !finite([step, density]) ||
    step <= 0 ||
    density <= 0 ||
    range.length !== 2 ||
    !finite(range) ||
    !(range[1] > range[0])
  )
    throw rangeError(
      'Preintegration needs a 1D function, 8..2048 samples, positive step/density and an increasing finite range; correct the options',
      'sciviz',
    );
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    options.signal?.throwIfAborted();
    for (let x = 0; x < n; x++) {
      const out = [0, 0, 0, 0];
      for (let j = 0; j < samples; j++) {
        const t = (j + 0.5) / samples,
          v = range[0] + ((x + (y - x) * t) / (n - 1)) * (range[1] - range[0]),
          c = evaluate(s, v, 0);
        const a = (1 - out[3]) * -Math.expm1((Math.log1p(-c[3]) * step * density) / samples);
        for (let k = 0; k < 3; k++) out[k] += a * c[k];
        out[3] += a;
      }
      for (let k = 0; k < 4; k++)
        rgba[(y * n + x) * 4 + k] = Math.round((k < 3 && out[3] ? out[k] / out[3] : out[k]) * 255);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  options.signal?.throwIfAborted();
  return { kind: 'preintegrated', size: [n, n], rgba, step, density, range: [range[0], range[1]] };
}

/** Joint value/gradient histogram with physical units, x fastest. */
export interface TransferHistogram {
  /** Scalar domain. */ readonly range: readonly [number, number];
  /** Positive upper gradient axis. */ readonly gradientMax: number;
  /** [value bins, gradient bins]. */ readonly bins: readonly [number, number];
  /** Counts, gradient row major. */ readonly counts: Uint32Array;
  /** Voxels with a complete finite derivative stencil. */ readonly valid: number;
  /** Missing centres or derivative neighbours, excluded from counts. */ readonly missing: number;
}
/** Central differences inside, one-sided differences on edges, divided by physical sample spacing. */
export async function transferHistogram(
  data: ArrayLike<number>,
  options: {
    /** [nx,ny,nz], x fastest, each at least two. */ readonly dims: readonly [number, number, number];
    /** Physical bounds; default sample indices. Descending axes are accepted. */ readonly bounds?: Bounds;
    /** Finite increasing scalar range. */ readonly range: readonly [number, number];
    /** Gradient upper bound. Default observed maximum, or 1 for a constant field. */ readonly gradientMax?: number;
    /** Number of bins per axis, default 256, 2..2048. */ readonly resolution?: number;
    /** Cancellation, exact reason. */ readonly signal?: AbortSignal;
  },
): Promise<TransferHistogram> {
  const { dims: d, range: r, signal } = options,
    n = options.resolution ?? 256;
  size(n);
  if (
    d.length !== 3 ||
    d.some((v) => !Number.isInteger(v) || v < 2) ||
    d[0] * d[1] * d[2] !== data.length ||
    data.length > 64_000_000 ||
    r.length !== 2 ||
    !finite(r) ||
    r[1] <= r[0]
  )
    throw rangeError(
      'Histogram needs 2..64000000 samples, matching dims and an increasing range; correct the grid',
      'sciviz',
    );
  const b = options.bounds ?? [0, d[0] - 1, 0, d[1] - 1, 0, d[2] - 1],
    spacing = d.map((v, a) => (b[a * 2 + 1] - b[a * 2]) / (v - 1));
  if (b.length !== 6 || !finite(b) || spacing.some((v) => v === 0))
    throw rangeError('Histogram bounds need three nonzero finite extents; correct the physical bounds', 'sciviz');
  signal?.throwIfAborted();
  const values = new Float64Array(data.length),
    gradients = new Float64Array(data.length),
    strides = [1, d[0], d[0] * d[1]];
  for (let i = 0; i < data.length; i++) {
    values[i] = data[i];
    if (i % 8192 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  let maximum = 0,
    valid = 0;
  for (let i = 0; i < values.length; i++) {
    const p = [i % d[0], Math.floor(i / d[0]) % d[1], Math.floor(i / strides[2])];
    let squared = 0;
    for (let a = 0; a < 3; a++) {
      const lo = p[a] > 0 ? 1 : 0,
        hi = p[a] < d[a] - 1 ? 1 : 0;
      const g = (values[i + hi * strides[a]] - values[i - lo * strides[a]]) / ((lo + hi) * spacing[a]);
      squared += g * g;
    }
    const gradient = Math.sqrt(squared);
    gradients[i] = Number.isFinite(values[i]) && Number.isFinite(gradient) ? gradient : NaN;
    if (Number.isFinite(gradients[i])) {
      maximum = Math.max(maximum, gradient);
      valid++;
    }
    if (i % 8192 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  const gradientMax = options.gradientMax ?? (maximum || 1),
    counts = new Uint32Array(n * n);
  if (!Number.isFinite(gradientMax) || gradientMax <= 0)
    throw rangeError('Histogram gradientMax must be positive; use the observed maximum', 'sciviz');
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(gradients[i])) {
      const x = Math.max(0, Math.min(n - 1, Math.floor(((values[i] - r[0]) / (r[1] - r[0])) * n))),
        y = Math.min(n - 1, Math.floor((gradients[i] / gradientMax) * n));
      counts[y * n + x]++;
    }
    if (i % 8192 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  return { range: [...r], gradientMax, bins: [n, n], counts, valid, missing: values.length - valid };
}

/** Modality presets are display starting points, not calibrated tissue identification. */
export function transferPreset(modality: 'ct-lung' | 'ct-bone' | 'ct-soft' | 'mri' | 'pet'): TransferFunction {
  const definitions = {
    'ct-lung': [
      [-1000, 0, 0, 0, 0],
      [-750, 0.4, 0.6, 0.9, 0.03],
      [-400, 0.8, 0.5, 0.3, 0.1],
      [400, 1, 0.9, 0.8, 0.6],
    ],
    'ct-bone': [
      [-1000, 0, 0, 0, 0],
      [150, 0.4, 0.2, 0.1, 0],
      [400, 0.8, 0.6, 0.4, 0.1],
      [1500, 1, 1, 0.9, 0.9],
    ],
    'ct-soft': [
      [-1000, 0, 0, 0, 0],
      [-100, 0.3, 0.1, 0.05, 0],
      [80, 0.8, 0.4, 0.3, 0.15],
      [500, 1, 0.9, 0.8, 0.6],
    ],
    mri: [
      [0, 0, 0, 0, 0],
      [0.2, 0.1, 0.2, 0.4, 0],
      [0.6, 0.5, 0.6, 0.8, 0.1],
      [1, 1, 1, 1, 0.7],
    ],
    pet: [
      [0, 0, 0, 0, 0],
      [0.25, 0.1, 0, 0.4, 0.01],
      [0.6, 1, 0.1, 0, 0.2],
      [1, 1, 1, 0.6, 0.8],
    ],
  };
  const p = definitions[modality];
  if (!p) throw rangeError('Unknown transfer preset; choose ct-lung, ct-bone, ct-soft, mri or pet', 'sciviz');
  return new TransferFunction({
    range: [p[0][0], p[p.length - 1][0]],
    gradientMax: modality.startsWith('ct') ? 200 : 1,
    points: p.map((v) => ({ value: v[0], rgba: v.slice(1) as unknown as TransferRGBA })),
  });
}

/** Bind an editable function to any existing scalar volume. The LUT is sampled over the layer range. Dispose restores its original classification. */
export function bindTransfer(
  layer: VolumeLayer,
  tf: TransferFunction,
  options: {
    /** LUT resolution, default 256. */ readonly resolution?: number;
    /** Called after each upload, e.g. render a stopped figure. Default absent. */ readonly render?: () => void;
    /** Cancels the binding's lifetime. */ readonly signal?: AbortSignal;
  } = {},
): {
  /** Restore original classification and remove listeners. */ dispose(): void /** Same as dispose. */;
  [Symbol.dispose](): void;
} {
  options.signal?.throwIfAborted();
  const previous = layer.getClassification();
  let disposed = false;
  let applied = false;
  const apply = () => {
    if (disposed) return;
    const table = tf.table(options.resolution, layer.range);
    applied = true;
    layer.setClassification(table);
    options.render?.();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    tf.removeEventListener('change', apply);
    options.signal?.removeEventListener('abort', dispose);
    if (applied && layer.valid) layer.setClassification(previous);
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  try {
    apply();
    if (!disposed) tf.addEventListener('change', apply);
  } catch (error) {
    try {
      dispose();
    } catch (rollback) {
      throw Object.assign(
        new AggregateError(
          [error, rollback],
          'Transfer binding setup and restoration failed; recreate the layer; see https://margoengine.com/errors#sciviz',
        ),
        { code: 'failed' },
      );
    }
    throw error;
  }
  return { dispose, [Symbol.dispose]: dispose };
}
