/// <reference lib="esnext.disposable" preserve="true" />
// Clean-room differentiable layers from Ioffe/Szegedy, Wu/He, Hochreiter/Schmidhuber,
// Cho et al. and the normative ONNX ConvTranspose/Resize/recurrent equations.
import { rangeError, typeError } from '../../shared/errors.js';
import { Tensor, Module, parameter, dropout, type InitOptions } from './nn.js';
import { Random } from './random.js';
import { concatenate, pad } from './shape.js';
import { where } from './expr.js';
import type { GpuArray, SliceSpec } from './array.js';
import type { ComputeContext, WaitOptions } from './context.js';

type Pair = readonly [number, number];
const count = (s: readonly number[]) => s.reduce((a, b) => a * b, 1);
const positive = (v: number, name: string) => {
  if (!Number.isInteger(v) || v < 1)
    throw rangeError(`${name} must be a positive integer; choose at least 1`, 'compute');
  return v;
};
const pair = (v: number | Pair, name: string, min = 0): Pair => {
  const a = typeof v === 'number' ? ([v, v] as const) : v;
  if (a.length !== 2 || a.some((n) => !Number.isInteger(n) || n < min))
    throw rangeError(`${name} needs two integers >= ${min}; choose valid dimensions`, 'compute');
  return a;
};
const constant = (v: GpuArray) => new Tensor(v, false, false);
function narrow(x: Tensor, axis: number, start: number, length: number): Tensor {
  const specs: SliceSpec[] = x.shape.map(() => null);
  specs[axis] = [start, start + length];
  return Tensor.made(x, x.value.slice(...specs).eval(), [x], (g) => {
    const widths = x.shape.map((_, k) =>
      k === axis ? ([start, x.shape[k] - start - length] as const) : ([0, 0] as const),
    );
    Tensor.give(x, pad(g, widths));
  });
}
function cat(xs: readonly Tensor[], axis: number): Tensor {
  if (!xs.length) throw rangeError('Concatenation needs at least one tensor; supply inputs', 'compute');
  if (xs.length === 1) return xs[0];
  const value = concatenate(
    xs.map((x) => x.value),
    axis,
  );
  return Tensor.made(xs[0], value, xs, (g) => {
    let at = 0;
    for (const x of xs) {
      const specs: SliceSpec[] = x.shape.map(() => null);
      specs[axis] = [at, at + x.shape[axis]];
      Tensor.give(x, g.slice(...specs).eval());
      at += x.shape[axis];
    }
  });
}
// Gather [lines,flat] through a shared table, with optional weights. Backprop sums
// repeated readers in the existing scatter primitive, as the existing Embedding does.
function gather(x: Tensor, ids: Uint32Array, shape: readonly number[], weights?: Float32Array, mask = false): Tensor {
  const c = x.context,
    table = c.array(ids, { shape }),
    lines = x.shape[0],
    flat = x.shape[1],
    line = c.arange(0, lines, 1, 'i32'),
    offsets = line
      .reshape(lines, ...shape.map(() => 1))
      .mul(flat)
      .add(table)
      .eval(),
    weight = weights ? c.array(weights, { shape }) : undefined;
  line.dispose();
  const read = c.take(x.value, table, { axis: 1 }),
    value = weight ? (mask ? where(weight, read, 0).eval() : read.mul(weight).eval()) : read;
  if (weight) read.dispose();
  return Tensor.made(
    x,
    value,
    [x],
    (g) => {
      const sum = c.zeros(x.shape),
        source = weight ? (mask ? where(weight, g, 0).eval() : g.mul(weight).eval()) : g;
      c.scatter(sum, offsets, source, { op: 'add' });
      if (weight) source.dispose();
      Tensor.give(x, sum);
    },
    [table, offsets, ...(weight ? [weight] : [])],
  );
}
function choose(mask: GpuArray, a: Tensor, b: Tensor): Tensor {
  if (a.context !== b.context)
    throw typeError('Recurrent states must use the input context; move the state first', 'compute');
  return Tensor.made(a, where(mask, a.value, b.value).eval(), [a, b], (g) => {
    Tensor.take(a, where(mask, g, 0));
    Tensor.take(b, where(mask, 0, g));
  });
}

/** Channel normalization options; affine defaults true and eps defaults 1e-5. */
export interface NormOptions {
  /** Numerical stabilizer. Default 1e-5; positive and finite. */
  readonly eps?: number;
  /** Learn channel scale and shift. Default true. */
  readonly affine?: boolean;
}
/** Batch normalization options. */
export interface BatchNormOptions extends NormOptions {
  /** Contribution of a new batch. Default 0.1; null uses a cumulative average. */
  readonly momentum?: number | null;
  /** Track buffers for inference. Default true. */
  readonly trackRunningStats?: boolean;
  /** Channel axis. Default 1 (NCHW); accepts negative axes. */
  readonly axis?: number;
}
const epsOf = (n: number) => {
  if (!(n > 0 && Number.isFinite(n)))
    throw rangeError('Normalization eps must be finite and positive; choose e.g. 1e-5', 'compute');
  return n;
};

/** Batch normalization of rank >=2, with differentiable batch statistics and unbiased running variance. */
export class BatchNorm extends Module {
  /** Learned [channels] scale, initially one, when affine is enabled. */
  readonly weight: Tensor | undefined;
  /** Learned [channels] shift, initially zero, when affine is enabled. */
  readonly bias: Tensor | undefined;
  /** Inference mean, initially zero. */
  readonly runningMean: GpuArray;
  /** Inference variance, initially one. */
  readonly runningVar: GpuArray;
  /** Number of batches incorporated into running statistics. */
  batchesTracked = 0;
  readonly #channels: number;
  readonly #eps: number;
  readonly #axis: number;
  readonly #momentum: number | null;
  readonly #track: boolean;
  constructor(c: ComputeContext, channels: number, options: BatchNormOptions = {}) {
    super();
    this.#channels = positive(channels, 'channels');
    this.#eps = epsOf(options.eps ?? 1e-5);
    this.#axis = options.axis ?? 1;
    this.#momentum = options.momentum === undefined ? 0.1 : options.momentum;
    if (this.#momentum !== null && !(Number.isFinite(this.#momentum) && this.#momentum >= 0 && this.#momentum <= 1))
      throw rangeError('BatchNorm momentum must be null or in [0,1]; choose a valid weight', 'compute');
    this.#track = options.trackRunningStats ?? true;
    this.runningMean = c.zeros(channels);
    this.runningVar = c.ones(channels);
    if (options.affine !== false) {
      this.weight = parameter(c.ones(channels));
      this.bias = parameter(c.zeros(channels));
    }
  }
  forward(x: Tensor): Tensor {
    const axis = this.#axis < 0 ? this.#axis + x.ndim : this.#axis;
    if (
      x.ndim < 2 ||
      axis < 0 ||
      axis >= x.ndim ||
      !Number.isInteger(axis) ||
      x.shape[axis] !== this.#channels ||
      x.context !== this.runningMean.context
    )
      throw rangeError(
        'BatchNorm input must share its context and channel dimension; use the configured axis',
        'compute',
      );
    const shape = x.shape.map((_, i) => (i === axis ? this.#channels : 1)),
      axes = [...x.shape.keys()].filter((i) => i !== axis),
      n = axes.reduce((n, i) => n * x.shape[i], 1);
    let out: Tensor;
    if (this.training || !this.#track) {
      if (n <= 1)
        throw rangeError(
          'BatchNorm training needs more than one value per channel; use eval() or a larger batch',
          'compute',
        );
      const mean = x.mean({ axis: axes, keepdims: true }),
        center = x.sub(mean),
        variance = center.mul(center).mean({ axis: axes, keepdims: true });
      if (this.#track) {
        const momentum = this.#momentum ?? 1 / (this.batchesTracked + 1),
          c = x.context,
          m = this.runningMean
            .mul(1 - momentum)
            .add(mean.value.reshape(this.#channels).mul(momentum))
            .eval(),
          v = this.runningVar
            .mul(1 - momentum)
            .add(variance.value.reshape(this.#channels).mul((momentum * n) / (n - 1)))
            .eval();
        c.submit(
          [],
          [
            [m.storage.buffer, 0, this.runningMean.storage.buffer, 0, this.#channels * 4],
            [v.storage.buffer, 0, this.runningVar.storage.buffer, 0, this.#channels * 4],
          ],
        );
        m.dispose();
        v.dispose();
        this.batchesTracked++;
      }
      out = center.mul(variance.add(this.#eps).rsqrt());
    } else
      out = x
        .sub(this.runningMean.reshape(...shape))
        .mul(constant(this.runningVar.add(this.#eps).rsqrt().eval().transfer(shape)));
    if (this.weight) out = out.mul(this.weight.reshape(...shape)).add(this.bias!.reshape(...shape));
    return out;
  }
  override async stateDict(options: WaitOptions = {}): Promise<Record<string, Float32Array>> {
    const read = { signal: options.signal };
    return {
      ...(await super.stateDict(read)),
      runningMean: (await this.runningMean.read(read)) as Float32Array,
      runningVar: (await this.runningVar.read(read)) as Float32Array,
      batchesTracked: new Float32Array([this.batchesTracked]),
    };
  }
  override loadStateDict(state: Readonly<Record<string, ArrayLike<number>>>): void {
    for (const name of ['runningMean', 'runningVar'])
      if (state[name]?.length !== this.#channels)
        throw rangeError(
          `State ${name} needs ${this.#channels} values; supply the saved normalization state`,
          'compute',
        );
    const n = state.batchesTracked?.[0];
    if (!Number.isInteger(n) || n < 0)
      throw rangeError(
        'State batchesTracked must be a nonnegative integer; supply the saved normalization state',
        'compute',
      );
    super.loadStateDict(state);
    this.runningMean.write(state.runningMean);
    this.runningVar.write(state.runningVar);
    this.batchesTracked = n;
  }
  override release(): void {
    this.runningMean.dispose();
    this.runningVar.dispose();
  }
}

/** Per-sample group normalization of [batch, channels, ...spatial], with train/eval equivalence. */
export class GroupNorm extends Module {
  /** Learned channel scale, initially one. */
  readonly weight: Tensor | undefined;
  /** Learned channel shift, initially zero. */
  readonly bias: Tensor | undefined;
  readonly #groups: number;
  readonly #channels: number;
  readonly #eps: number;
  readonly #context: ComputeContext;
  constructor(c: ComputeContext, groups: number, channels: number, options: NormOptions = {}) {
    super();
    this.#groups = positive(groups, 'groups');
    this.#channels = positive(channels, 'channels');
    this.#eps = epsOf(options.eps ?? 1e-5);
    this.#context = c;
    if (channels % groups)
      throw rangeError('GroupNorm channels must be divisible by groups; choose a common divisor', 'compute');
    if (options.affine !== false) {
      this.weight = parameter(c.ones(channels));
      this.bias = parameter(c.zeros(channels));
    }
  }
  forward(x: Tensor): Tensor {
    if (x.ndim < 2 || x.shape[1] !== this.#channels || x.context !== this.#context)
      throw rangeError('GroupNorm needs [batch, channels, ...spatial] in its context; check channels', 'compute');
    const n = x.shape[0],
      grouped = x.reshape(n, this.#groups, this.#channels / this.#groups, ...x.shape.slice(2)),
      axis = [...grouped.shape.keys()].slice(2),
      o = { axis, keepdims: true },
      center = grouped.sub(grouped.mean(o));
    let out = center.mul(center.mul(center).mean(o).add(this.#eps).rsqrt()).reshape(...x.shape);
    const affine = [1, this.#channels, ...x.shape.slice(2).map(() => 1)];
    if (this.weight) out = out.mul(this.weight.reshape(...affine)).add(this.bias!.reshape(...affine));
    return out;
  }
}

/** Transposed 2D convolution options, with NCHW input and [in, out/groups, kh, kw] weights. */
export interface ConvTransposeOptions extends InitOptions {
  /** Spatial stride. Default 1. */ readonly stride?: number | Pair;
  /** Symmetric spatial padding. Default 0. */ readonly padding?: number | Pair;
  /** Spacing between kernel taps. Default 1. */ readonly dilation?: number | Pair;
  /** Additional high-side output pixels. Default 0, less than stride or dilation. */ readonly outputPadding?:
    | number
    | Pair;
  /** Independent channel groups. Default 1. */ readonly groups?: number;
  /** Learn a bias. Default true. */ readonly bias?: boolean;
}
/** Differentiable grouped/dilated transposed convolution, including explicit output size. */
export class ConvTranspose2d extends Module {
  /** [inChannels, outChannels/groups, kh, kw] parameters. */ readonly weight: Tensor;
  /** Optional [outChannels] learned bias. */ readonly bias: Tensor | undefined;
  readonly #in: number;
  readonly #out: number;
  readonly #groups: number;
  readonly #kernel: Pair;
  readonly #stride: Pair;
  readonly #padding: Pair;
  readonly #dilation: Pair;
  readonly #outputPadding: Pair;
  constructor(
    c: ComputeContext,
    inChannels: number,
    outChannels: number,
    kernelSize: number | Pair,
    options: ConvTransposeOptions = {},
  ) {
    super();
    this.#in = positive(inChannels, 'inChannels');
    this.#out = positive(outChannels, 'outChannels');
    this.#groups = positive(options.groups ?? 1, 'groups');
    if (inChannels % this.#groups || outChannels % this.#groups)
      throw rangeError('Transposed convolution channels must divide into groups; choose a common divisor', 'compute');
    this.#kernel = pair(kernelSize, 'kernelSize', 1);
    this.#stride = pair(options.stride ?? 1, 'stride', 1);
    this.#padding = pair(options.padding ?? 0, 'padding');
    this.#dilation = pair(options.dilation ?? 1, 'dilation', 1);
    this.#outputPadding = pair(options.outputPadding ?? 0, 'outputPadding');
    if (this.#outputPadding.some((v, i) => v >= Math.max(this.#stride[i], this.#dilation[i])))
      throw rangeError('outputPadding must be less than stride or dilation; choose a smaller value', 'compute');
    const rng = options.rng ?? new Random(c),
      bound = 1 / Math.sqrt((outChannels / this.#groups) * count(this.#kernel));
    this.weight = parameter(
      rng.uniform([inChannels, outChannels / this.#groups, ...this.#kernel], { low: -bound, high: bound }),
    );
    if (options.bias !== false) this.bias = parameter(rng.uniform(outChannels, { low: -bound, high: bound }));
  }
  forward(x: Tensor): Tensor {
    return this.withOutputSize(x);
  }
  /** Chooses a valid spatial output size instead of the configured output padding. */
  withOutputSize(x: Tensor, outputSize?: Pair): Tensor {
    if (x.ndim !== 4 || x.shape[1] !== this.#in || x.context !== this.weight.context)
      throw rangeError(
        'ConvTranspose2d needs [batch, inChannels, h, w] in its context; check input channels',
        'compute',
      );
    const [n, , h, w] = x.shape,
      [kh, kw] = this.#kernel,
      [sh, sw] = this.#stride,
      [ph, pw] = this.#padding,
      [dh, dw] = this.#dilation,
      base = [(h - 1) * sh - 2 * ph + dh * (kh - 1) + 1, (w - 1) * sw - 2 * pw + dw * (kw - 1) + 1],
      spatial = outputSize ?? [base[0] + this.#outputPadding[0], base[1] + this.#outputPadding[1]],
      [oh, ow] = spatial;
    if (
      !spatial.every(
        (v, i) =>
          Number.isInteger(v) &&
          v >= Math.max(1, base[i]) &&
          v < base[i] + (outputSize ? this.#stride[i] : Math.max(this.#stride[i], this.#dilation[i])),
      )
    )
      throw rangeError(
        'Transposed convolution output size is outside its stride range; use the inferred output size',
        'compute',
      );
    const ci = this.#in / this.#groups,
      co = this.#out / this.#groups,
      taps = ci * kh * kw,
      parts: Tensor[] = [],
      flat = x.reshape(n, this.#in * h * w);
    for (let group = 0; group < this.#groups; group++) {
      const ids = new Uint32Array(oh * ow * taps),
        valid = new Float32Array(ids.length);
      let at = 0;
      for (let y = 0; y < oh; y++)
        for (let xx = 0; xx < ow; xx++)
          for (let c = 0; c < ci; c++)
            for (let ky = 0; ky < kh; ky++)
              for (let kx = 0; kx < kw; kx++, at++) {
                const iy = (y + ph - ky * dh) / sh,
                  ix = (xx + pw - kx * dw) / sw;
                if (Number.isInteger(iy) && Number.isInteger(ix) && iy >= 0 && iy < h && ix >= 0 && ix < w) {
                  ids[at] = ((group * ci + c) * h + iy) * w + ix;
                  valid[at] = 1;
                }
              }
      const columns = gather(flat, ids, [oh * ow, taps], valid, true),
        weight = narrow(this.weight, 0, group * ci, ci)
          .permute(1, 0, 2, 3)
          .reshape(co, taps);
      parts.push(columns.matmul(weight.permute(1, 0)));
    }
    let out = cat(parts, 2).permute(0, 2, 1).reshape(n, this.#out, oh, ow);
    if (this.bias) out = out.add(this.bias.reshape(1, this.#out, 1, 1));
    return out;
  }
}

/** Interpolation of one, two or three spatial axes after [batch, channels]. */
export interface UpsampleOptions {
  /** Explicit spatial output dimensions, exclusive with scaleFactor. */ readonly size?: number | readonly number[];
  /** Positive spatial scale factors. Default 2, exclusive with size. */ readonly scaleFactor?:
    | number
    | readonly number[];
  /** nearest, linear (1D/2D/3D), or bicubic (2D). Default nearest. */ readonly mode?:
    | 'nearest'
    | 'linear'
    | 'bilinear'
    | 'trilinear'
    | 'bicubic';
  /** Align the first and last pixel centers for linear/cubic interpolation. Default false. */ readonly alignCorners?: boolean;
}
/** Differentiable upsampling, including edge replication and half-pixel linear/cubic coordinates. */
export function upsample(x: Tensor, options: UpsampleOptions = {}): Tensor {
  const rank = x.ndim - 2,
    input = x.shape.slice(2),
    mode = options.mode ?? 'nearest';
  if (rank < 1 || rank > 3 || input.some((d) => d < 1))
    throw rangeError('Upsampling needs [batch, channels, 1..3 nonempty spatial axes]; reshape the input', 'compute');
  if (
    !['nearest', 'linear', 'bilinear', 'trilinear', 'bicubic'].includes(mode) ||
    (mode === 'bicubic' && rank !== 2) ||
    (mode === 'bilinear' && rank !== 2) ||
    (mode === 'trilinear' && rank !== 3)
  )
    throw rangeError('Interpolation mode must match the spatial rank; use nearest or linear', 'compute');
  if (options.size !== undefined && options.scaleFactor !== undefined)
    throw rangeError('Choose either size or scaleFactor for upsampling', 'compute');
  const dims = (v: number | readonly number[]) => (typeof v === 'number' ? (Array(rank).fill(v) as number[]) : [...v]);
  const scales = dims(options.scaleFactor ?? 2),
    out = options.size === undefined ? input.map((n, i) => Math.floor(n * scales[i])) : dims(options.size);
  if (
    out.length !== rank ||
    out.some((d) => !Number.isSafeInteger(d) || d < 1) ||
    (options.size === undefined && (scales.length !== rank || scales.some((d) => !(Number.isFinite(d) && d > 0))))
  )
    throw rangeError('Upsampling sizes/scales must be positive and match spatial rank; supply one per axis', 'compute');
  const nearest = mode === 'nearest',
    taps = nearest ? 1 : mode === 'bicubic' ? 4 : 2,
    per = taps ** rank,
    positions = count(out),
    ids = new Uint32Array(positions * per),
    weights = new Float32Array(ids.length),
    cubic = (v: number) => {
      const a = -0.75,
        t = Math.abs(v);
      return t <= 1
        ? (a + 2) * t * t * t - (a + 3) * t * t + 1
        : t < 2
          ? a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a
          : 0;
    };
  for (let position = 0; position < positions; position++) {
    let rest = position;
    const coords = new Array<number>(rank);
    for (let d = rank - 1; d >= 0; d--) {
      const c = rest % out[d];
      rest = Math.floor(rest / out[d]);
      coords[d] = nearest
        ? Math.floor((c * input[d]) / out[d])
        : options.alignCorners
          ? out[d] === 1
            ? 0
            : (c * (input[d] - 1)) / (out[d] - 1)
          : ((c + 0.5) * input[d]) / out[d] - 0.5;
    }
    for (let tap = 0; tap < per; tap++) {
      let code = tap,
        at = 0,
        weight = 1;
      for (let d = rank - 1, step = 1; d >= 0; step *= input[d--]) {
        const lane = code % taps;
        code = Math.floor(code / taps);
        const base = Math.floor(coords[d]),
          index = nearest ? base : base + lane - (taps === 4 ? 1 : 0);
        if (!nearest)
          weight *= taps === 4 ? cubic(coords[d] - index) : lane === 0 ? 1 - (coords[d] - base) : coords[d] - base;
        at += Math.min(input[d] - 1, Math.max(0, index)) * step;
      }
      ids[position * per + tap] = at;
      weights[position * per + tap] = weight;
    }
  }
  const values = gather(
    x.reshape(x.shape[0] * x.shape[1], count(input)),
    ids,
    [positions, per],
    nearest ? undefined : weights,
  );
  return values.sum({ axis: 2 }).reshape(x.shape[0], x.shape[1], ...out);
}
/** A reusable differentiable interpolation module. Options default to 2x nearest. */
export class Upsample extends Module {
  readonly #options: UpsampleOptions;
  constructor(options: UpsampleOptions = {}) {
    super();
    this.#options = {
      ...options,
      size: Array.isArray(options.size) ? [...options.size] : options.size,
      scaleFactor: Array.isArray(options.scaleFactor) ? [...options.scaleFactor] : options.scaleFactor,
    };
  }
  forward(x: Tensor): Tensor {
    return upsample(x, this.#options);
  }
}

/** Recurrent layer options. */
export interface RecurrentOptions extends InitOptions {
  /** Stacked recurrent layers. Default 1. */ readonly numLayers?: number;
  /** Two directions with output channels concatenated. Default false. */ readonly bidirectional?: boolean;
  /** [batch, time, features] input/output, rather than [time, batch, features]. Default false. */ readonly batchFirst?: boolean;
  /** Learned input and recurrent biases. Default true. */ readonly bias?: boolean;
  /** Dropout between stacked layers only. Default 0. */ readonly dropout?: number;
}
/** Optional recurrent state and padded-sequence lengths. */
export interface RecurrentState {
  /** [layers * directions, batch, hidden]. Default zeros. */ readonly h?: Tensor;
  /** LSTM cell state with the same shape. Default zeros. */ readonly c?: Tensor;
  /** One integer length in [0,time] per batch item. Default full length. */ readonly lengths?: readonly number[];
}
/** Recurrent sequence and final states. Output order always matches input time order. */
export interface RecurrentResult {
  /** [time,batch,directions*hidden], or batch-first when configured. */ readonly output: Tensor;
  /** Final state [layers*directions,batch,hidden]. */ readonly h: Tensor;
  /** Final LSTM cell state; undefined for GRU. */ readonly c?: Tensor;
}
class Cell extends Module {
  readonly weightIH: Tensor;
  readonly weightHH: Tensor;
  readonly biasIH: Tensor | undefined;
  readonly biasHH: Tensor | undefined;
  constructor(ctx: ComputeContext, input: number, hidden: number, gates: number, bias: boolean, rng: Random) {
    super();
    const bound = 1 / Math.sqrt(hidden),
      make = (s: number | number[]) => parameter(rng.uniform(s, { low: -bound, high: bound }));
    this.weightIH = make([gates * hidden, input]);
    this.weightHH = make([gates * hidden, hidden]);
    if (bias) {
      this.biasIH = make(gates * hidden);
      this.biasHH = make(gates * hidden);
    }
  }
  forward(x: Tensor): Tensor {
    return x.matmul(this.weightIH.permute(1, 0));
  }
}
abstract class Recurrent extends Module {
  /** Per-layer/per-direction input, recurrent and bias parameters, in layer-major order. */ readonly cells: Cell[] =
    [];
  readonly #input: number;
  readonly #hidden: number;
  readonly #layers: number;
  readonly #directions: number;
  readonly #batchFirst: boolean;
  readonly #dropout: number;
  readonly #lstm: boolean;
  readonly #rng: Random;
  constructor(ctx: ComputeContext, inputSize: number, hiddenSize: number, options: RecurrentOptions, lstm: boolean) {
    super();
    this.#input = positive(inputSize, 'inputSize');
    this.#hidden = positive(hiddenSize, 'hiddenSize');
    this.#layers = positive(options.numLayers ?? 1, 'numLayers');
    this.#directions = options.bidirectional ? 2 : 1;
    this.#batchFirst = options.batchFirst ?? false;
    this.#dropout = options.dropout ?? 0;
    this.#lstm = lstm;
    this.#rng = options.rng ?? new Random(ctx);
    if (!(this.#dropout >= 0 && this.#dropout < 1))
      throw rangeError('Recurrent dropout must be in [0,1); choose a valid probability', 'compute');
    for (let l = 0; l < this.#layers; l++)
      for (let d = 0; d < this.#directions; d++)
        this.cells.push(
          new Cell(
            ctx,
            l === 0 ? inputSize : hiddenSize * this.#directions,
            hiddenSize,
            lstm ? 4 : 3,
            options.bias !== false,
            this.#rng,
          ),
        );
  }
  forward(x: Tensor): Tensor {
    const result = this.run(x),
      time = x.shape[this.#batchFirst ? 1 : 0];
    if (time === 0) {
      result.h.dispose();
      result.c?.dispose();
    } else {
      result.h.value.dispose();
      result.c?.value.dispose();
    }
    return result.output;
  }
  /** Runs a complete sequence and exposes final states, without retaining mutable hidden state in the module. */
  run(input: Tensor, state: RecurrentState = {}): RecurrentResult {
    const x = this.#batchFirst ? input.permute(1, 0, 2) : input;
    if (x.ndim !== 3 || x.shape[2] !== this.#input || x.context !== this.cells[0].weightIH.context)
      throw rangeError(
        'Recurrent input needs [time,batch,inputSize] in its context; check batchFirst and features',
        'compute',
      );
    const [time, batch] = x.shape,
      hidden = this.#hidden,
      states = this.#layers * this.#directions,
      stateShape = [states, batch, hidden],
      c = x.context;
    for (const v of [state.h, state.c])
      if (v && (v.context !== c || v.shape.length !== 3 || v.shape.some((n, i) => n !== stateShape[i])))
        throw rangeError(
          'Initial recurrent states need [layers*directions,batch,hidden]; use the layer state shape',
          'compute',
        );
    if (!this.#lstm && state.c) throw typeError('GRU has no cell state; pass only h', 'compute');
    if (
      state.lengths &&
      (state.lengths.length !== batch || state.lengths.some((v) => !Number.isInteger(v) || v < 0 || v > time))
    )
      throw rangeError('Sequence lengths need one integer in [0,time] per batch item; supply valid lengths', 'compute');
    const initialH = state.h ?? constant(c.zeros(stateShape)),
      initialC = this.#lstm ? (state.c ?? constant(c.zeros(stateShape))) : undefined,
      hfinal: Tensor[] = [],
      cfinal: Tensor[] = [];
    let sequence = x;
    for (let layer = 0; layer < this.#layers; layer++) {
      const directions: Tensor[] = [];
      for (let d = 0; d < this.#directions; d++) {
        const index = layer * this.#directions + d,
          cell = this.cells[index],
          rows: Tensor[] = new Array(time);
        let h = narrow(initialH, 0, index, 1).reshape(batch, hidden),
          v = initialC ? narrow(initialC, 0, index, 1).reshape(batch, hidden) : undefined;
        for (let step = 0; step < time; step++) {
          const t = d === 0 ? step : time - 1 - step,
            xt = narrow(sequence, 0, t, 1).reshape(batch, sequence.shape[2]);
          let ig = xt.matmul(cell.weightIH.permute(1, 0)),
            hg = h.matmul(cell.weightHH.permute(1, 0));
          if (cell.biasIH) ig = ig.add(cell.biasIH);
          if (cell.biasHH) hg = hg.add(cell.biasHH);
          let nextH: Tensor, nextC: Tensor | undefined;
          if (this.#lstm) {
            const gates = ig.add(hg),
              i = narrow(gates, 1, 0, hidden).sigmoid(),
              f = narrow(gates, 1, hidden, hidden).sigmoid(),
              g = narrow(gates, 1, 2 * hidden, hidden).tanh(),
              o = narrow(gates, 1, 3 * hidden, hidden).sigmoid();
            nextC = f.mul(v!).add(i.mul(g));
            nextH = o.mul(nextC.tanh());
          } else {
            const r = narrow(ig, 1, 0, hidden)
                .add(narrow(hg, 1, 0, hidden))
                .sigmoid(),
              z = narrow(ig, 1, hidden, hidden)
                .add(narrow(hg, 1, hidden, hidden))
                .sigmoid(),
              candidate = narrow(ig, 1, 2 * hidden, hidden)
                .add(r.mul(narrow(hg, 1, 2 * hidden, hidden)))
                .tanh();
            nextH = candidate.mul(z.mul(-1).add(1)).add(z.mul(h));
          }
          if (state.lengths) {
            const mask = c.array(
              state.lengths.map((n) => (t < n ? 1 : 0)),
              { shape: [batch, 1], dtype: 'u32' },
            );
            h = choose(mask, nextH, h);
            if (nextC) v = choose(mask, nextC, v!);
            const emitted = choose(mask, h, constant(c.zeros([batch, hidden])));
            rows[t] = Tensor.made(emitted, emitted.value.eval(), [emitted], (g) => Tensor.give(emitted, g.eval()), [
              mask,
            ]);
          } else {
            h = nextH;
            if (nextC) v = nextC;
            rows[t] = h;
          }
        }
        hfinal.push(h.reshape(1, batch, hidden));
        if (v) cfinal.push(v.reshape(1, batch, hidden));
        directions.push(
          time
            ? cat(
                rows.map((y) => y.reshape(1, batch, hidden)),
                0,
              )
            : constant(c.zeros([0, batch, hidden])),
        );
      }
      sequence = cat(directions, 2);
      if (this.training && this.#dropout && layer + 1 < this.#layers)
        sequence = dropout(sequence, this.#dropout, this.#rng);
    }
    return {
      output: this.#batchFirst ? sequence.permute(1, 0, 2) : sequence,
      h: cat(hfinal, 0),
      c: this.#lstm ? cat(cfinal, 0) : undefined,
    };
  }
}
/** Stacked/bidirectional LSTM with i,f,g,o gates, trainable biases and full backpropagation through time. */
export class LSTM extends Recurrent {
  constructor(c: ComputeContext, inputSize: number, hiddenSize: number, options: RecurrentOptions = {}) {
    super(c, inputSize, hiddenSize, options, true);
  }
}
/** Stacked/bidirectional GRU with r,z,n gates and reset applied after recurrent candidate projection. */
export class GRU extends Recurrent {
  constructor(c: ComputeContext, inputSize: number, hiddenSize: number, options: RecurrentOptions = {}) {
    super(c, inputSize, hiddenSize, options, false);
  }
}
