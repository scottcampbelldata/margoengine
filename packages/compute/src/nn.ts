/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/compute/nn: neural network layers for training and inference, PyTorch style. Layers run on a tape of
// Tensors, each holding an evaluated GpuArray and how to send a gradient to its parents (reverse-mode differentiation:
// D. E. Rumelhart, G. E. Hinton and R. J. Williams, "Learning representations by back-propagating errors", Nature 323,
// 1986). Everything is built from the package's own arrays, expressions, matrix products and gathers, so a network runs
// unchanged on WebGPU and on the CPU backend.
//
// Convolution unfolds the input into columns and multiplies (K. Chellapilla, S. Puri and P. Simard, "High performance
// convolutional neural networks for document processing", IWFHR 2006). Unfolding is a gather through a table made once
// per input size; its gradient is the gather through the inverse table, summed, so it needs no atomics and repeats
// exactly. Also here: scaled dot-product attention (A. Vaswani et al., "Attention is all you need", NeurIPS 2017), layer
// normalization (J. L. Ba, J. R. Kiros and G. E. Hinton, arXiv 1607.06450, 2016), GELU in its tanh form (D. Hendrycks and
// K. Gimpel, arXiv 1606.08415, 2016), Adam (D. P. Kingma and J. Ba, ICLR 2015) and AdamW (I. Loshchilov and F. Hutter,
// ICLR 2019).
import { rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import type { ComputeContext } from './context.js';
import { type Operand, where } from './expr.js';
import { matmul } from './linalg.js';
import { Random } from './random.js';

let recording = true;

/** Runs `work` without recording gradients: tensors made inside have `requiresGrad` false. */
export function noGrad<T>(work: () => T): T {
  const before = recording;
  recording = false;
  try {
    return work();
  } finally {
    recording = before;
  }
}

/** Sum of `g` over the axes broadcasting added, as a new array of `shape`. */
function reduceTo(g: Operand, shape: readonly number[]): GpuArray {
  const extra = g.ndim - shape.length,
    axes: number[] = [];
  for (let k = 0; k < g.ndim; k++) if (k < extra || (shape[k - extra] === 1 && g.shape[k] !== 1)) axes.push(k);
  if (!axes.length) return g.eval();
  return g.sum({ axis: axes, keepdims: true }).transfer(shape);
}

const swapLast = (a: GpuArray): GpuArray => {
  const axes = [...a.shape.keys()];
  [axes[a.ndim - 1], axes[a.ndim - 2]] = [axes[a.ndim - 2], axes[a.ndim - 1]];
  return a.transpose(...axes);
};

const countOf = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);

const axesOf = (axis: number | readonly number[] | undefined, ndim: number): number[] =>
  axis === undefined
    ? [...Array(ndim).keys()]
    : (typeof axis === 'number' ? [axis] : [...axis]).map((a) => (a < 0 ? a + ndim : a));

/** Options of the reducing methods of {@link Tensor}. */
export interface TensorAxisOptions {
  /** Axis or axes to reduce. Default every axis. */
  readonly axis?: number | readonly number[];
  /** Keep reduced axes as size 1. Default false. */
  readonly keepdims?: boolean;
}

type Other = Tensor | GpuArray | number;

/**
 * A value on the tape: a GpuArray, its gradient once `backward` has run, and how it was made. Methods return new
 * tensors. `loss.backward()` queues the whole backward pass; `loss.dispose()` (or `using`) frees everything the
 * forward and backward passes made, and leaves parameters, their gradients and your own input arrays alone.
 */
export class Tensor {
  /** The values. Evaluated: reading it needs no further work. */
  readonly value: GpuArray;
  /** The gradient of the last `backward`, summed over calls until `zeroGrad`. Kept on leaves only. */
  grad: GpuArray | undefined;
  /** True when gradients flow to or through this tensor. */
  readonly requiresGrad: boolean;
  readonly #parents: readonly Tensor[];
  readonly #send: ((g: GpuArray) => void) | undefined;
  readonly #owned: readonly GpuArray[];
  readonly #leaf: boolean;

  /** @internal Use {@link tensor}, {@link parameter} or the methods. */
  constructor(
    value: GpuArray,
    requiresGrad: boolean,
    leaf: boolean,
    parents: readonly Tensor[] = [],
    send?: (g: GpuArray) => void,
    owned: readonly GpuArray[] = [],
  ) {
    this.value = value;
    this.requiresGrad = requiresGrad;
    this.#leaf = leaf;
    this.#parents = parents;
    this.#send = send;
    this.#owned = owned;
  }

  /** Dimensions of the value. */
  get shape(): readonly number[] {
    return this.value.shape;
  }
  /** Number of dimensions. */
  get ndim(): number {
    return this.value.ndim;
  }
  /** The compute context of the value. */
  get context(): ComputeContext {
    return this.value.context;
  }

  /** The values as a TypedArray, in C order. */
  read(): ReturnType<GpuArray['read']> {
    return this.value.read();
  }
  /** The one value of a single-element tensor. */
  item(): Promise<number> {
    return this.value.item();
  }

  /** @internal Adds an array this call now owns to the gradient. */
  accumulate(g: GpuArray): void {
    if (!this.grad) {
      this.grad = g;
      return;
    }
    const sum = this.grad.add(g).eval();
    this.grad.dispose();
    g.dispose();
    this.grad = sum;
  }

  // Sends an expression to this tensor's gradient, summed back to its shape.
  #take(g: Operand): void {
    if (this.requiresGrad) this.accumulate(reduceTo(g, this.shape));
  }

  // Sends a new array, which this call owns.
  #give(g: GpuArray): void {
    if (!this.requiresGrad) g.dispose();
    else if (g.shape.length === this.ndim && g.shape.every((d, k) => d === this.shape[k])) this.accumulate(g);
    else {
      this.accumulate(reduceTo(g, this.shape));
      g.dispose();
    }
  }

  /**
   * Queues the backward pass from this tensor: the gradient of its value (of `sum(value * seed)` with `seed`) lands in
   * `grad` of every leaf that requires one. Without `seed` the tensor must hold a single element.
   */
  backward(seed?: GpuArray): void {
    if (!this.requiresGrad)
      throw typeError(
        'backward needs a tensor that depends on a parameter; none of its inputs requires a gradient',
        'compute',
      );
    if (!seed && this.value.size !== 1)
      throw rangeError(`backward of ${this.value.size} elements needs a seed; reduce to one value first`, 'compute');
    const order: Tensor[] = [],
      seen = new Set<Tensor>(),
      stack: [Tensor, number][] = [[this, 0]];
    // Depth first and without recursion, since a network may be deeper than the call stack.
    seen.add(this);
    while (stack.length) {
      const top = stack[stack.length - 1],
        next = top[0].#parents[top[1]++];
      if (!next) {
        order.push(top[0]);
        stack.pop();
      } else if (next.requiresGrad && !seen.has(next)) {
        seen.add(next);
        stack.push([next, 0]);
      }
    }
    this.accumulate(seed ? reduceTo(seed, this.shape) : this.context.ones(this.shape));
    for (let k = order.length - 1; k >= 0; k--) {
      const node = order[k],
        g = node.grad;
      if (node.#leaf || !g) continue;
      node.#send?.(g);
      g.dispose();
      node.grad = undefined;
    }
  }

  /** Clears this tensor's gradient. */
  zeroGrad(): void {
    this.grad?.dispose();
    this.grad = undefined;
  }

  /** Frees what made this tensor, back to the leaves. Parameters, their gradients and input arrays stay. */
  dispose(): void {
    const stack: Tensor[] = [this],
      seen = new Set<Tensor>(stack);
    while (stack.length) {
      const node = stack.pop()!;
      if (node.#leaf) continue;
      node.grad?.dispose();
      node.grad = undefined;
      node.value.dispose();
      for (const a of node.#owned) a.dispose();
      for (const parent of node.#parents)
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
    }
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  // A new tensor made from `parents`.
  #made(value: GpuArray, parents: readonly Tensor[], send: (g: GpuArray) => void, owned?: GpuArray[]): Tensor {
    const needs = recording && parents.some((p) => p.requiresGrad);
    return new Tensor(value, needs, false, parents, needs ? send : undefined, owned);
  }

  /** @internal Lets the free functions of this module build tape nodes. */
  static made(
    from: Tensor,
    value: GpuArray,
    parents: readonly Tensor[],
    send: (g: GpuArray) => void,
    owned?: GpuArray[],
  ): Tensor {
    return from.#made(value, parents, send, owned);
  }

  /** @internal */
  static take(to: Tensor, g: Operand): void {
    to.#take(g);
  }

  /** @internal */
  static give(to: Tensor, g: GpuArray): void {
    to.#give(g);
  }

  /** Element-wise sum, with NumPy's broadcasting. */
  add(other: Other): Tensor {
    const b = lift(this, other);
    if (b === undefined) return this.#scalar(this.value.add(other as number).eval(), 1);
    return this.#made(this.value.add(b.value).eval(), [this, b], (g) => {
      this.#take(g);
      b.#take(g);
    });
  }

  /** Element-wise difference. */
  sub(other: Other): Tensor {
    const b = lift(this, other);
    if (b === undefined) return this.#scalar(this.value.sub(other as number).eval(), 1);
    return this.#made(this.value.sub(b.value).eval(), [this, b], (g) => {
      this.#take(g);
      b.#take(g.neg());
    });
  }

  /** Element-wise product. */
  mul(other: Other): Tensor {
    const b = lift(this, other);
    if (b === undefined) return this.#scalar(this.value.mul(other as number).eval(), other as number);
    return this.#made(this.value.mul(b.value).eval(), [this, b], (g) => {
      this.#take(g.mul(b.value));
      b.#take(g.mul(this.value));
    });
  }

  /** Element-wise quotient. */
  div(other: Other): Tensor {
    const b = lift(this, other);
    if (b === undefined) return this.#scalar(this.value.div(other as number).eval(), 1 / (other as number));
    return this.#made(this.value.div(b.value).eval(), [this, b], (g) => {
      this.#take(g.div(b.value));
      b.#take(g.mul(this.value).neg().div(b.value.square()));
    });
  }

  #scalar(value: GpuArray, factor: number): Tensor {
    return this.#made(value, [this], (g) => this.#take(factor === 1 ? g : g.mul(factor)));
  }

  /** Matrix product over the last two dimensions; leading dimensions broadcast as a batch. Both need two or more. */
  matmul(other: Tensor | GpuArray): Tensor {
    const b = lift(this, other)!;
    if (this.ndim < 2 || b.ndim < 2)
      throw rangeError(
        `Tensor matmul needs two or more dimensions, got [${this.shape.join(', ')}] and [${b.shape.join(', ')}]; reshape first`,
        'compute',
      );
    return this.#made(matmul(this.value, b.value), [this, b], (g) => {
      if (this.requiresGrad) this.#give(matmul(g, swapLast(b.value)));
      if (b.requiresGrad) b.#give(matmul(swapLast(this.value), g));
    });
  }

  /** Sum over `axis` (default every axis). */
  sum(options: TensorAxisOptions = {}): Tensor {
    const keep = this.#kept(options);
    return this.#made(this.value.sum(options), [this], (g) => {
      this.#give(g.reshape(keep).broadcastTo(this.shape).eval());
    });
  }

  /** Mean over `axis` (default every axis). */
  mean(options: TensorAxisOptions = {}): Tensor {
    const n = axesOf(options.axis, this.ndim).reduce((c, a) => c * this.shape[a], 1);
    const sum = this.sum(options);
    return sum.mul(1 / n);
  }

  /** Maximum over one axis; the gradient goes to the first maximum of each line. */
  max(options: { readonly axis: number; readonly keepdims?: boolean }): Tensor {
    const keep = this.#kept(options),
      axis = axesOf(options.axis, this.ndim)[0],
      winner = this.value.argmax({ axis, keepdims: true }),
      line = this.context.arange(0, this.shape[axis], 1, 'u32'),
      along = this.shape.map((d, k) => (k === axis ? d : 1));
    return this.#made(
      this.value.max(options),
      [this],
      (g) => {
        this.#give(where(line.reshape(along).eq(winner), g.reshape(keep), 0).eval());
      },
      [winner, line],
    );
  }

  #kept(options: TensorAxisOptions): number[] {
    const axes = axesOf(options.axis, this.ndim);
    return this.shape.map((d, k) => (axes.includes(k) ? 1 : d));
  }

  /** The same elements in another shape (one dimension may be -1). */
  reshape(...shape: number[]): Tensor {
    const source = this.value.ascontiguous(),
      copied = source !== this.value,
      from = this.shape;
    return this.#made(
      source.reshape(...shape),
      [this],
      (g) => {
        this.#give(g.reshape(...from).eval());
      },
      copied ? [source] : [],
    );
  }

  /** The dimensions in the order `axes`, as a view. */
  permute(...axes: number[]): Tensor {
    const back = axes.map((_, k) => axes.indexOf(k));
    return this.#made(this.value.transpose(...axes), [this], (g) => {
      this.#give(g.transpose(...back).eval());
    });
  }

  #map(value: GpuArray, derivative: (g: GpuArray, y: GpuArray) => Operand): Tensor {
    return this.#made(value, [this], (g) => this.#take(derivative(g, value)));
  }

  /** e to the power of each element. */
  exp(): Tensor {
    return this.#map(this.value.exp().eval(), (g, y) => g.mul(y));
  }
  /** Natural logarithm. */
  log(): Tensor {
    return this.#map(this.value.log().eval(), (g) => g.div(this.value));
  }
  /** 1 over the square root. */
  rsqrt(): Tensor {
    return this.#map(this.value.rsqrt().eval(), (g, y) => g.mul(y).mul(y).mul(y).mul(-0.5));
  }
  /** max(x, 0). */
  relu(): Tensor {
    const x = this.value;
    return this.#map(where(x.gt(0), x, 0).eval(), (g) => where(x.gt(0), g, 0));
  }
  /** x above 0, `slope` times x below. */
  leakyRelu(slope = 0.01): Tensor {
    const x = this.value;
    return this.#map(where(x.gt(0), x, x.mul(slope)).eval(), (g) => where(x.gt(0), g, g.mul(slope)));
  }
  /** The logistic function. */
  sigmoid(): Tensor {
    return this.#map(this.value.neg().exp().add(1).reciprocal().eval(), (g, y) => g.mul(y).mul(y.neg().add(1)));
  }
  /** Hyperbolic tangent. */
  tanh(): Tensor {
    return this.#map(this.value.tanh().eval(), (g, y) => g.mul(y.square().neg().add(1)));
  }
  /** x times its sigmoid (also called swish). */
  silu(): Tensor {
    const x = this.value,
      s = x.neg().exp().add(1).reciprocal();
    return this.#map(x.mul(s).eval(), (g) => g.mul(s.mul(x.mul(s.neg().add(1)).add(1))));
  }
  /** GELU in its tanh form. */
  gelu(): Tensor {
    const x = this.value,
      c = Math.sqrt(2 / Math.PI),
      t = x.add(x.mul(x).mul(x).mul(0.044715)).mul(c).tanh();
    return this.#map(x.mul(0.5).mul(t.add(1)).eval(), (g) => {
      const inner = x
        .square()
        .mul(3 * 0.044715)
        .add(1)
        .mul(c);
      return g.mul(
        t
          .add(1)
          .mul(0.5)
          .add(x.mul(0.5).mul(t.square().neg().add(1)).mul(inner)),
      );
    });
  }

  /** Softmax along `axis` (default the last). */
  softmax(axis = -1): Tensor {
    const o = { axis, keepdims: true },
      top = this.value.max(o),
      e = this.value.sub(top).exp(),
      total = e.sum(o),
      y = e.div(total).eval();
    top.dispose();
    total.dispose();
    return this.#made(y, [this], (g) => {
      const dot = g.mul(y).sum(o);
      this.#take(y.mul(g.sub(dot)));
      dot.dispose();
    });
  }

  /** Log of the softmax along `axis` (default the last), without its overflow. */
  logSoftmax(axis = -1): Tensor {
    const o = { axis, keepdims: true },
      top = this.value.max(o),
      total = this.value.sub(top).exp().sum(o),
      y = this.value.sub(top).sub(total.log()).eval();
    top.dispose();
    total.dispose();
    return this.#made(y, [this], (g) => {
      const sum = g.sum(o);
      this.#take(g.sub(y.exp().mul(sum)));
      sum.dispose();
    });
  }
}

// `other` as a tensor, or undefined for a plain number.
function lift(from: Tensor, other: Other): Tensor | undefined {
  if (typeof other === 'number') return undefined;
  if (other instanceof Tensor) return other;
  if (other instanceof GpuArray) return new Tensor(other, false, true);
  throw typeError('Tensor operands are Tensors, GpuArrays or numbers', 'compute');
}

/** A leaf tensor over `array`, which stays yours. With `requiresGrad`, `backward` fills its `grad`. */
export function tensor(array: GpuArray, options: { readonly requiresGrad?: boolean } = {}): Tensor {
  if (!(array instanceof GpuArray)) throw typeError('tensor takes a GpuArray; use gpu.array(data) first', 'compute');
  return new Tensor(array, !!options.requiresGrad, true);
}

/** A leaf tensor to train: it requires a gradient, and optimizers update its array in place. */
export function parameter(array: GpuArray): Tensor {
  return tensor(array, { requiresGrad: true });
}

// An array of this graph that is not an input: freed with the graph.
const constant = (value: GpuArray): Tensor => new Tensor(value, false, false);

/** Mean squared error between `prediction` and `target`. */
export function mseLoss(prediction: Tensor, target: Tensor | GpuArray): Tensor {
  const difference = prediction.sub(target);
  return difference.mul(difference).mean();
}

/**
 * Softmax cross-entropy between `logits` ([..., classes]) and integer class `labels` (one per row), averaged over the
 * rows. Takes logits, as PyTorch's `cross_entropy` does: do not apply softmax first.
 */
export function crossEntropy(logits: Tensor, labels: GpuArray): Tensor {
  const classes = logits.shape[logits.ndim - 1],
    rows = logits.value.size / classes;
  if (labels.size !== rows)
    throw rangeError(`crossEntropy has ${rows} rows of logits but ${labels.size} labels`, 'compute');
  const gpu = logits.context,
    flat = logits.reshape(rows, classes),
    logp = flat.logSoftmax(),
    line = gpu.arange(0, classes, 1, 'i32'),
    ids = labels.astype('i32').eval(),
    hot = ids.reshape(rows, 1).eq(line.reshape(1, classes)).astype('f32').eval();
  line.dispose();
  ids.dispose();
  return logp
    .mul(constant(hot))
    .sum()
    .mul(-1 / rows);
}

/** Zeroes each element with probability `p` and scales the rest by 1 / (1 - p). */
export function dropout(x: Tensor, p: number, rng: Random): Tensor {
  if (!(p >= 0 && p < 1)) throw rangeError(`dropout p must be in [0, 1), got ${p}`, 'compute');
  const noise = rng.uniform(x.shape as number[]),
    mask = noise
      .ge(p)
      .astype('f32')
      .mul(1 / (1 - p))
      .eval();
  noise.dispose();
  return x.mul(constant(mask));
}

/** The gather tables of one input size: forward taps and their inverse. */
interface Unfolding {
  readonly positions: number;
  readonly taps: number;
  readonly outH: number;
  readonly outW: number;
  readonly table: GpuArray;
  readonly valid: GpuArray | undefined;
  readonly inverse: GpuArray;
  readonly inverseValid: GpuArray;
}

type Pair = readonly [number, number];
const pair = (v: number | Pair, name: string, least: number): Pair => {
  const out = typeof v === 'number' ? ([v, v] as const) : v;
  if (out.length !== 2 || !out.every((d) => Number.isInteger(d) && d >= least))
    throw rangeError(
      `${name} must be a whole number of at least ${least}, or two of them, got ${String(v)}`,
      'compute',
    );
  return out;
};

/** Kernel geometry of a convolution or pooling layer. */
interface Window {
  readonly kernel: Pair;
  readonly stride: Pair;
  readonly padding: Pair;
  readonly dilation: Pair;
}

/** Host tables for channels x h x w: `taps[p][c, i, j]` reads a flat input index, `inverse` lists who read each one. */
function unfolding(gpu: ComputeContext, channels: number, h: number, w: number, win: Window): Unfolding {
  const [kh, kw] = win.kernel,
    [sh, sw] = win.stride,
    [ph, pw] = win.padding,
    [dh, dw] = win.dilation;
  const outH = Math.floor((h + 2 * ph - dh * (kh - 1) - 1) / sh) + 1,
    outW = Math.floor((w + 2 * pw - dw * (kw - 1) - 1) / sw) + 1;
  if (outH < 1 || outW < 1)
    throw rangeError(
      `A ${kh} x ${kw} window does not fit a ${h} x ${w} input; lower the kernel or add padding`,
      'compute',
    );
  const positions = outH * outW,
    taps = channels * kh * kw,
    size = channels * h * w,
    table = new Int32Array(positions * taps),
    valid = new Uint32Array(positions * taps),
    readers = new Uint32Array(size);
  let padded = false;
  for (let oy = 0, slot = 0; oy < outH; oy++)
    for (let ox = 0; ox < outW; ox++)
      for (let c = 0; c < channels; c++)
        for (let i = 0; i < kh; i++)
          for (let j = 0; j < kw; j++, slot++) {
            const y = oy * sh - ph + i * dh,
              x = ox * sw - pw + j * dw;
            if (y < 0 || y >= h || x < 0 || x >= w) {
              padded = true;
              continue;
            }
            const at = (c * h + y) * w + x;
            table[slot] = at;
            valid[slot] = 1;
            readers[at]++;
          }
  const most = Math.max(1, ...readers),
    inverse = new Int32Array(size * most),
    inverseValid = new Uint32Array(size * most);
  readers.fill(0);
  for (let slot = 0; slot < table.length; slot++)
    if (valid[slot]) {
      const at = table[slot],
        k = at * most + readers[at]++;
      inverse[k] = slot;
      inverseValid[k] = 1;
    }
  return {
    positions,
    taps,
    outH,
    outW,
    table: gpu.array(table, { shape: [positions, taps] }),
    valid: padded ? gpu.array(valid, { shape: [positions, taps] }) : undefined,
    inverse: gpu.array(inverse, { shape: [size, most] }),
    inverseValid: gpu.array(inverseValid, { shape: [size, most] }),
  };
}

/** [n, size] gathered into [n, positions, taps]; `fill` stands in for reads past the edge. */
function unfold(x: Tensor, u: Unfolding, fill: number): Tensor {
  const gpu = x.context,
    n = x.shape[0];
  let value = gpu.take(x.value, u.table, { axis: 1 });
  if (u.valid) {
    const masked = where(u.valid, value, fill).eval();
    value.dispose();
    value = masked;
  }
  return Tensor.made(x, value, [x], (g) => {
    const flat = g.reshape(n, u.positions * u.taps),
      read = gpu.take(flat, u.inverse, { axis: 1 });
    Tensor.give(x, where(u.inverseValid, read, 0).sum({ axis: 2 }));
    read.dispose();
  });
}

/** Scaled dot-product attention options. */
export interface AttentionOptions {
  /** Each position attends only to itself and earlier ones. Default false. */
  readonly causal?: boolean;
}

/**
 * softmax(q k^T / sqrt(d)) v over the last two dimensions: q is [..., t, d], k and v [..., s, d]. The score matrix
 * [..., t, s] is held in memory, so memory grows with t times s.
 */
export function scaledDotProductAttention(q: Tensor, k: Tensor, v: Tensor, options: AttentionOptions = {}): Tensor {
  const d = q.shape[q.ndim - 1],
    last = [...k.shape.keys()],
    axes = [...last.slice(0, -2), last[last.length - 1], last[last.length - 2]];
  let scores = q.matmul(k.permute(...axes)).mul(1 / Math.sqrt(d));
  if (options.causal) {
    const gpu = q.context,
      t = q.shape[q.ndim - 2],
      s = k.shape[k.ndim - 2],
      rows = gpu.arange(0, t, 1, 'i32'),
      cols = gpu.arange(0, s, 1, 'i32'),
      block = where(cols.reshape(1, s).gt(rows.reshape(t, 1)), -Infinity, 0).eval();
    rows.dispose();
    cols.dispose();
    scores = scores.add(constant(block));
  }
  return scores.softmax().matmul(v);
}

/** A part of a network. Subclasses set layers and parameters as plain properties and define `forward`. */
export abstract class Module {
  /** True while training (the default): dropout is on. */
  training = true;

  /** Runs the layer. */
  abstract forward(x: Tensor, ...rest: Tensor[]): Tensor;

  /** Every parameter with its dotted name, in property order. */
  namedParameters(prefix = ''): [string, Tensor][] {
    const out: [string, Tensor][] = [];
    const visit = (name: string, value: unknown) => {
      if (value instanceof Tensor) {
        if (value.requiresGrad) out.push([name, value]);
      } else if (value instanceof Module) out.push(...value.namedParameters(`${name}.`));
      else if (Array.isArray(value)) value.forEach((item, k) => visit(`${name}.${k}`, item));
    };
    for (const [key, value] of Object.entries(this)) visit(`${prefix}${key}`, value);
    return out;
  }

  /** Every parameter. */
  parameters(): Tensor[] {
    return this.namedParameters().map(([, p]) => p);
  }

  #each(visit: (m: Module) => void): void {
    visit(this);
    const walk = (value: unknown) => {
      if (value instanceof Module) value.#each(visit);
      else if (Array.isArray(value)) value.forEach(walk);
    };
    Object.values(this).forEach(walk);
  }

  /** Switches this module and those inside it to training (or, with false, to evaluation). Returns this. */
  train(mode = true): this {
    this.#each((m) => (m.training = mode));
    return this;
  }

  /** Switches to evaluation: dropout is off. Returns this. */
  eval(): this {
    return this.train(false);
  }

  /** Inference on an array: no gradients, evaluation mode, and only the result stays allocated. */
  predict(input: GpuArray): GpuArray {
    const was = this.training;
    this.train(false);
    try {
      return noGrad(() => {
        using out = this.forward(tensor(input));
        return out.value.eval();
      });
    } finally {
      this.train(was);
    }
  }

  /** The parameters and each child module's saved state, by dotted name. */
  async stateDict(): Promise<Record<string, Float32Array>> {
    const out: Record<string, Float32Array> = {};
    const visit = async (name: string, value: unknown): Promise<void> => {
      if (value instanceof Tensor) {
        if (value.requiresGrad) out[name] = (await value.value.read()) as Float32Array;
      } else if (value instanceof Module) {
        for (const [key, data] of Object.entries(await value.stateDict())) out[`${name}.${key}`] = data;
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) await visit(`${name}.${i}`, value[i]);
      }
    };
    for (const [name, value] of Object.entries(this)) await visit(name, value);
    return out;
  }

  /** Writes saved values into the parameters. Every parameter must be present, in its size. */
  loadStateDict(state: Readonly<Record<string, ArrayLike<number>>>): void {
    for (const [name, p] of this.namedParameters()) {
      const data = state[name];
      if (!data) throw rangeError(`State has no parameter ${name}`, 'compute');
      if (data.length !== p.value.size)
        throw rangeError(`State's ${name} has ${data.length} values; the parameter has ${p.value.size}`, 'compute');
    }
    const visit = (name: string, value: unknown): void => {
      if (value instanceof Tensor) {
        if (value.requiresGrad) value.value.write(state[name]);
      } else if (value instanceof Module) {
        const nested: Record<string, ArrayLike<number>> = {};
        for (const [key, data] of Object.entries(state))
          if (key.startsWith(`${name}.`)) nested[key.slice(name.length + 1)] = data;
        value.loadStateDict(nested);
      } else if (Array.isArray(value)) value.forEach((item, i) => visit(`${name}.${i}`, item));
    };
    for (const [name, value] of Object.entries(this)) visit(name, value);
  }

  /** Frees the parameters, their gradients and the layer's tables. */
  dispose(): void {
    for (const p of this.parameters()) {
      p.zeroGrad();
      p.value.dispose();
    }
    this.#each((m) => m.release());
  }

  /** @internal Frees what a layer holds besides parameters. */
  release(): void {}

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Options for layers with random starting weights. */
export interface InitOptions {
  /** Generator for the starting weights, to make them repeat. Default a new, randomly seeded one. */
  readonly rng?: Random;
}

const uniformWeights = (rng: Random, shape: readonly number[], bound: number) =>
  parameter(rng.uniform(shape as number[], { low: -bound, high: bound }));

/** y = x W^T + b over the last dimension. W is [outFeatures, inFeatures]. */
export class Linear extends Module {
  /** [outFeatures, inFeatures]. */
  readonly weight: Tensor;
  /** [outFeatures], unless made with `bias: false`. */
  readonly bias: Tensor | undefined;

  constructor(
    gpu: ComputeContext,
    inFeatures: number,
    outFeatures: number,
    options: InitOptions & { readonly bias?: boolean } = {},
  ) {
    super();
    const rng = options.rng ?? new Random(gpu),
      bound = 1 / Math.sqrt(inFeatures);
    this.weight = uniformWeights(rng, [outFeatures, inFeatures], bound);
    this.bias = options.bias === false ? undefined : uniformWeights(rng, [outFeatures], bound);
  }

  forward(x: Tensor): Tensor {
    const y = x.matmul(this.weight.permute(1, 0));
    return this.bias ? y.add(this.bias) : y;
  }
}

/** Geometry of a convolution. */
export interface ConvOptions extends InitOptions {
  /** Step between windows. Default 1. */
  readonly stride?: number | Pair;
  /** Zeros added on each side. Default 0. */
  readonly padding?: number | Pair;
  /** Spacing between kernel taps. Default 1. */
  readonly dilation?: number | Pair;
  /** Add a learned bias per output channel. Default true. */
  readonly bias?: boolean;
}

// Tables per input size, made on first use and kept.
class Tables {
  readonly #made = new Map<string, Unfolding>();
  of(gpu: ComputeContext, channels: number, h: number, w: number, win: Window): Unfolding {
    const key = `${channels},${h},${w}`;
    let u = this.#made.get(key);
    if (!u) this.#made.set(key, (u = unfolding(gpu, channels, h, w, win)));
    return u;
  }
  dispose(): void {
    for (const u of this.#made.values()) for (const a of [u.table, u.valid, u.inverse, u.inverseValid]) a?.dispose();
    this.#made.clear();
  }
}

/** 2D convolution (cross-correlation, as in every deep learning library) of [n, channels, h, w] input. */
export class Conv2d extends Module {
  /** [outChannels, inChannels, kh, kw]. */
  readonly weight: Tensor;
  /** [outChannels], unless made with `bias: false`. */
  readonly bias: Tensor | undefined;
  readonly #win: Window;
  readonly #tables = new Tables();
  readonly #in: number;

  constructor(
    gpu: ComputeContext,
    inChannels: number,
    outChannels: number,
    kernelSize: number | Pair,
    options: ConvOptions = {},
  ) {
    super();
    const kernel = pair(kernelSize, 'kernelSize', 1),
      rng = options.rng ?? new Random(gpu),
      bound = 1 / Math.sqrt(inChannels * kernel[0] * kernel[1]);
    this.#in = inChannels;
    this.#win = {
      kernel,
      stride: pair(options.stride ?? 1, 'stride', 1),
      padding: pair(options.padding ?? 0, 'padding', 0),
      dilation: pair(options.dilation ?? 1, 'dilation', 1),
    };
    this.weight = uniformWeights(rng, [outChannels, inChannels, kernel[0], kernel[1]], bound);
    this.bias = options.bias === false ? undefined : uniformWeights(rng, [outChannels], bound);
  }

  forward(x: Tensor): Tensor {
    if (x.ndim !== 4 || x.shape[1] !== this.#in)
      throw rangeError(`Conv2d takes [n, ${this.#in}, h, w], got [${x.shape.join(', ')}]`, 'compute');
    const [n, c, h, w] = x.shape,
      out = this.weight.shape[0],
      u = this.#tables.of(x.context, c, h, w, this.#win);
    const columns = unfold(x.reshape(n, c * h * w), u, 0);
    let y = columns.matmul(this.weight.reshape(out, u.taps).permute(1, 0));
    if (this.bias) y = y.add(this.bias);
    return y.permute(0, 2, 1).reshape(n, out, u.outH, u.outW);
  }

  override release(): void {
    this.#tables.dispose();
  }
}

/** 1D convolution of [n, channels, length] input. Weights are [outChannels, inChannels, 1, kernelSize]. */
export class Conv1d extends Module {
  /** The 2D convolution this layer runs on a height of 1. */
  readonly conv: Conv2d;

  constructor(
    gpu: ComputeContext,
    inChannels: number,
    outChannels: number,
    kernelSize: number,
    options: Omit<ConvOptions, 'stride' | 'padding' | 'dilation'> & {
      readonly stride?: number;
      readonly padding?: number;
      readonly dilation?: number;
    } = {},
  ) {
    super();
    this.conv = new Conv2d(gpu, inChannels, outChannels, [1, kernelSize], {
      ...options,
      stride: [1, options.stride ?? 1],
      padding: [0, options.padding ?? 0],
      dilation: [1, options.dilation ?? 1],
    });
  }

  forward(x: Tensor): Tensor {
    if (x.ndim !== 3) throw rangeError(`Conv1d takes [n, channels, length], got [${x.shape.join(', ')}]`, 'compute');
    const [n, c, length] = x.shape,
      y = this.conv.forward(x.reshape(n, c, 1, length));
    return y.reshape(n, y.shape[1], y.shape[3]);
  }
}

/** Geometry of a pooling layer. */
export interface PoolOptions {
  /** Step between windows. Default the kernel size. */
  readonly stride?: number | Pair;
  /** Added on each side, at most half the kernel. Default 0. */
  readonly padding?: number | Pair;
}

abstract class Pool2d extends Module {
  readonly #win: Window;
  readonly #tables = new Tables();

  constructor(kernelSize: number | Pair, options: PoolOptions = {}) {
    super();
    const kernel = pair(kernelSize, 'kernelSize', 1),
      padding = pair(options.padding ?? 0, 'padding', 0);
    if (padding[0] * 2 > kernel[0] || padding[1] * 2 > kernel[1])
      throw rangeError(`Pool padding is at most half the kernel, got ${padding} for ${kernel}`, 'compute');
    this.#win = { kernel, stride: pair(options.stride ?? kernel, 'stride', 1), padding, dilation: [1, 1] };
  }

  protected abstract fold(windows: Tensor): Tensor;
  protected abstract readonly edge: number;

  forward(x: Tensor): Tensor {
    if (x.ndim !== 4) throw rangeError(`Pooling takes [n, channels, h, w], got [${x.shape.join(', ')}]`, 'compute');
    const [n, c, h, w] = x.shape,
      u = this.#tables.of(x.context, 1, h, w, this.#win);
    return this.fold(unfold(x.reshape(n * c, h * w), u, this.edge)).reshape(n, c, u.outH, u.outW);
  }

  override release(): void {
    this.#tables.dispose();
  }
}

/** Largest value of each window of [n, channels, h, w] input. */
export class MaxPool2d extends Pool2d {
  protected readonly edge = -Infinity;
  protected fold(windows: Tensor): Tensor {
    return windows.max({ axis: 2 });
  }
}

/** Mean of each window of [n, channels, h, w] input. Padding counts as zeros in the mean. */
export class AvgPool2d extends Pool2d {
  protected readonly edge = 0;
  protected fold(windows: Tensor): Tensor {
    return windows.mean({ axis: 2 });
  }
}

/** Keeps the first dimension and flattens the rest. */
export class Flatten extends Module {
  forward(x: Tensor): Tensor {
    return x.reshape(x.shape[0], -1);
  }
}

/** Runs layers in order. */
export class Sequential extends Module {
  /** The layers. */
  readonly layers: readonly Module[];
  constructor(...layers: Module[]) {
    super();
    this.layers = layers;
  }
  forward(x: Tensor): Tensor {
    return this.layers.reduce((value, layer) => layer.forward(value), x);
  }
}

/** See {@link Tensor.relu}. */
export class ReLU extends Module {
  forward(x: Tensor): Tensor {
    return x.relu();
  }
}
/** See {@link Tensor.leakyRelu}. */
export class LeakyReLU extends Module {
  constructor(readonly slope = 0.01) {
    super();
  }
  forward(x: Tensor): Tensor {
    return x.leakyRelu(this.slope);
  }
}
/** See {@link Tensor.gelu}. */
export class GELU extends Module {
  forward(x: Tensor): Tensor {
    return x.gelu();
  }
}
/** See {@link Tensor.silu}. */
export class SiLU extends Module {
  forward(x: Tensor): Tensor {
    return x.silu();
  }
}
/** See {@link Tensor.sigmoid}. */
export class Sigmoid extends Module {
  forward(x: Tensor): Tensor {
    return x.sigmoid();
  }
}
/** See {@link Tensor.tanh}. */
export class Tanh extends Module {
  forward(x: Tensor): Tensor {
    return x.tanh();
  }
}
/** See {@link Tensor.softmax}. */
export class Softmax extends Module {
  constructor(readonly axis = -1) {
    super();
  }
  forward(x: Tensor): Tensor {
    return x.softmax(this.axis);
  }
}

/** See {@link dropout}. Off in evaluation mode. */
export class Dropout extends Module {
  readonly #rng: Random | undefined;
  #own: Random | undefined;
  constructor(
    readonly p = 0.5,
    options: InitOptions = {},
  ) {
    super();
    if (!(p >= 0 && p < 1)) throw rangeError(`Dropout p must be in [0, 1), got ${p}`, 'compute');
    this.#rng = options.rng;
  }
  forward(x: Tensor): Tensor {
    if (!this.training || this.p === 0) return x;
    return dropout(x, this.p, this.#rng ?? (this.#own ??= new Random(x.context)));
  }
}

/** Normalizes the last dimension to mean 0 and variance 1, then scales and shifts it by learned values. */
export class LayerNorm extends Module {
  /** Scale, [features], starting at 1. */
  readonly weight: Tensor;
  /** Shift, [features], starting at 0. */
  readonly bias: Tensor;
  readonly #eps: number;

  constructor(gpu: ComputeContext, features: number, options: { readonly eps?: number } = {}) {
    super();
    this.weight = parameter(gpu.ones(features));
    this.bias = parameter(gpu.zeros(features));
    this.#eps = options.eps ?? 1e-5;
  }

  forward(x: Tensor): Tensor {
    const o = { axis: -1, keepdims: true },
      centred = x.sub(x.mean(o));
    const scale = centred.mul(centred).mean(o).add(this.#eps).rsqrt();
    return centred.mul(scale).mul(this.weight).add(this.bias);
  }
}

/** Rows of a learned table, looked up by integer ids of any shape. */
export class Embedding extends Module {
  /** [count, dim]. */
  readonly weight: Tensor;

  constructor(gpu: ComputeContext, count: number, dim: number, options: InitOptions = {}) {
    super();
    this.weight = parameter((options.rng ?? new Random(gpu)).normal([count, dim]));
  }

  forward(ids: Tensor): Tensor {
    const w = this.weight,
      gpu = w.context,
      dim = w.shape[1],
      flat = ids.value.reshape(ids.value.size),
      rows = gpu.take(w.value, flat, { axis: 0 });
    return Tensor.made(
      w,
      rows.reshape(...ids.shape, dim),
      [w],
      (g) => {
        // Ids repeat, so rows add atomically: the order of float additions is the GPU's.
        const sum = gpu.zeros(w.shape),
          ints = flat.astype('i32').eval(),
          line = gpu.arange(0, dim, 1, 'i32'),
          offsets = ints.reshape(flat.size, 1).mul(dim).add(line).eval();
        gpu.scatter(sum, offsets, g, { op: 'add' });
        for (const a of [ints, line, offsets]) a.dispose();
        Tensor.give(w, sum);
      },
      [rows],
    );
  }
}

/** Multi-head attention: self-attention with one argument, or query, key and value. Input is [batch, length, dim]. */
export class MultiHeadAttention extends Module {
  /** Query projection. */
  readonly query: Linear;
  /** Key projection. */
  readonly key: Linear;
  /** Value projection. */
  readonly value: Linear;
  /** Output projection. */
  readonly output: Linear;
  readonly #heads: number;
  readonly #causal: boolean;

  constructor(
    gpu: ComputeContext,
    dim: number,
    heads: number,
    options: InitOptions & AttentionOptions & { readonly bias?: boolean } = {},
  ) {
    super();
    if (!Number.isInteger(heads) || heads < 1 || dim % heads)
      throw rangeError(`MultiHeadAttention dim ${dim} must split evenly into ${heads} heads`, 'compute');
    const rng = options.rng ?? new Random(gpu),
      o = { rng, bias: options.bias };
    this.query = new Linear(gpu, dim, dim, o);
    this.key = new Linear(gpu, dim, dim, o);
    this.value = new Linear(gpu, dim, dim, o);
    this.output = new Linear(gpu, dim, dim, o);
    this.#heads = heads;
    this.#causal = !!options.causal;
  }

  #split(x: Tensor): Tensor {
    const [batch, length, dim] = x.shape;
    return x.reshape(batch, length, this.#heads, dim / this.#heads).permute(0, 2, 1, 3);
  }

  forward(query: Tensor, key: Tensor = query, value: Tensor = key): Tensor {
    if (query.ndim !== 3)
      throw rangeError(`MultiHeadAttention takes [batch, length, dim], got [${query.shape.join(', ')}]`, 'compute');
    const [batch, length, dim] = query.shape;
    const mixed = scaledDotProductAttention(
      this.#split(this.query.forward(query)),
      this.#split(this.key.forward(key)),
      this.#split(this.value.forward(value)),
      { causal: this.#causal },
    );
    return this.output.forward(mixed.permute(0, 2, 1, 3).reshape(batch, length, dim));
  }
}

// Writes an expression into `target`'s buffer, so references to the array stay good.
function assign(target: GpuArray, value: Operand): void {
  const next = value.eval();
  target.context.submit([], [[next.buffer, 0, target.buffer, target.offset * 4, target.byteLength]]);
  next.dispose();
}

/** What every optimizer shares. */
export abstract class Optimizer {
  /** The parameters it updates. */
  readonly parameters: readonly Tensor[];
  /** Learning rate; change it between steps to schedule it. */
  lr: number;

  constructor(parameters: readonly Tensor[], lr: number) {
    if (!parameters.length) throw rangeError('An optimizer needs at least one parameter', 'compute');
    if (!(lr > 0)) throw rangeError(`Learning rate must be above 0, got ${lr}`, 'compute');
    this.parameters = parameters;
    this.lr = lr;
  }

  /** Clears every parameter's gradient; call it before each `backward`. */
  zeroGrad(): void {
    for (const p of this.parameters) p.zeroGrad();
  }

  /** Updates each parameter that has a gradient. */
  abstract step(): void;

  /** Frees the optimizer's state. */
  abstract dispose(): void;

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Options of {@link SGD}. */
export interface SGDOptions {
  /** Learning rate. Default 0.01. */
  readonly lr?: number;
  /** Momentum. Default 0. */
  readonly momentum?: number;
  /** L2 penalty added to the gradient. Default 0. */
  readonly weightDecay?: number;
}

/** Stochastic gradient descent with optional momentum. */
export class SGD extends Optimizer {
  readonly #momentum: number;
  readonly #decay: number;
  readonly #velocity = new Map<Tensor, GpuArray>();

  constructor(parameters: readonly Tensor[], options: SGDOptions = {}) {
    super(parameters, options.lr ?? 0.01);
    this.#momentum = options.momentum ?? 0;
    this.#decay = options.weightDecay ?? 0;
  }

  step(): void {
    for (const p of this.parameters) {
      if (!p.grad) continue;
      const g = this.#decay ? p.grad.add(p.value.mul(this.#decay)) : p.grad;
      if (!this.#momentum) {
        assign(p.value, p.value.sub(g.mul(this.lr)));
        continue;
      }
      let v = this.#velocity.get(p);
      if (v) assign(v, v.mul(this.#momentum).add(g));
      else this.#velocity.set(p, (v = g.eval()));
      assign(p.value, p.value.sub(v.mul(this.lr)));
    }
  }

  dispose(): void {
    for (const v of this.#velocity.values()) v.dispose();
    this.#velocity.clear();
  }
}

/** Options of {@link Adam} and {@link AdamW}. */
export interface AdamOptions {
  /** Learning rate. Default 0.001. */
  readonly lr?: number;
  /** Decay of the two moving averages. Default [0.9, 0.999]. */
  readonly betas?: readonly [number, number];
  /** Added to the denominator. Default 1e-8. */
  readonly eps?: number;
  /** Adam: L2 penalty added to the gradient, default 0. AdamW: decay applied to the weights, default 0.01. */
  readonly weightDecay?: number;
}

/** Adam: steps scaled by running averages of the gradient and its square. */
export class Adam extends Optimizer {
  readonly #betas: readonly [number, number];
  readonly #eps: number;
  /** @internal */
  protected readonly decay: number;
  readonly #moments = new Map<Tensor, [GpuArray, GpuArray]>();
  #t = 0;

  constructor(parameters: readonly Tensor[], options: AdamOptions = {}, decay = 0) {
    super(parameters, options.lr ?? 0.001);
    this.#betas = options.betas ?? [0.9, 0.999];
    this.#eps = options.eps ?? 1e-8;
    this.decay = options.weightDecay ?? decay;
  }

  /** @internal The gradient the moments see. */
  protected gradient(p: Tensor, g: GpuArray): Operand {
    return this.decay ? g.add(p.value.mul(this.decay)) : g;
  }

  /** @internal The value the update starts from. */
  protected start(p: Tensor): Operand {
    return p.value;
  }

  step(): void {
    this.#t++;
    const [b1, b2] = this.#betas,
      c1 = 1 - b1 ** this.#t,
      c2 = 1 - b2 ** this.#t;
    for (const p of this.parameters) {
      if (!p.grad) continue;
      const g = this.gradient(p, p.grad);
      let moments = this.#moments.get(p);
      if (!moments) {
        const gpu = p.context;
        this.#moments.set(p, (moments = [gpu.zeros(p.shape), gpu.zeros(p.shape)]));
      }
      const [m, v] = moments;
      assign(m, m.mul(b1).add(g.mul(1 - b1)));
      assign(v, v.mul(b2).add(g.square().mul(1 - b2)));
      assign(
        p.value,
        this.start(p).sub(
          m.mul(this.lr / c1).div(
            v
              .mul(1 / c2)
              .sqrt()
              .add(this.#eps),
          ),
        ),
      );
    }
  }

  dispose(): void {
    for (const [m, v] of this.#moments.values()) {
      m.dispose();
      v.dispose();
    }
    this.#moments.clear();
  }
}

/**
 * Adam with weight decay applied to the weights directly instead of through the gradient. Each step multiplies the
 * weights by `1 - lr * weightDecay` (the PyTorch convention). Loshchilov and Hutter's Algorithm 2 subtracts
 * eta_t * lambda * theta, which the learning rate does not scale: their lambda is `lr * weightDecay` here.
 */
export class AdamW extends Adam {
  constructor(parameters: readonly Tensor[], options: AdamOptions = {}) {
    super(parameters, options, 0.01);
  }
  protected override gradient(_p: Tensor, g: GpuArray): Operand {
    return g;
  }
  protected override start(p: Tensor): Operand {
    return this.decay ? p.value.mul(1 - this.lr * this.decay) : p.value;
  }
}
