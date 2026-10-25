// @margoengine/compute/signal: convolution and correlation, 1-D (NumPy `convolve` / `correlate` modes) and 2-D (SciPy
// `convolve2d` with zero fill), batched over leading dimensions. Small kernels run directly (one thread per output);
// large ones through the FFT (the convolution theorem: a transform of each, a product, an inverse transform).
import { rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import { Operand } from './expr.js';
import { fft, fft2, ifft, ifft2 } from './fft.js';
import type { ComputeContext } from './context.js';

/** Which part of the full convolution to return. */
export type ConvolveMode = 'full' | 'same' | 'valid';

/** Options for convolution. */
export interface ConvolveOptions {
  /** `'full'` (every overlap, NumPy's convolve default), `'same'` (the input's size, centred) or `'valid'` (complete overlaps). */
  readonly mode?: ConvolveMode;
  /** `'direct'`, `'fft'`, or `'auto'` (default: direct for kernels up to 64 taps in 1-D or 15 x 15 in 2-D). */
  readonly method?: 'auto' | 'direct' | 'fft';
}

const contiguousF32 = (x: Operand): { array: GpuArray; owned: boolean } =>
  x instanceof GpuArray && x.dtype === 'f32' && x.contiguous && x.offset === 0
    ? { array: x, owned: false }
    : { array: x.astype('f32').eval(), owned: true };

// Output length and the full-convolution index of the first output for each mode.
function window(n: number, m: number, mode: ConvolveMode): { length: number; start: number } {
  if (mode === 'full') return { length: n + m - 1, start: 0 };
  if (mode === 'same') {
    const length = Math.max(n, m);
    return { length, start: Math.floor((n + m - 1 - length) / 2) };
  }
  if (mode === 'valid') return { length: Math.max(n, m) - Math.min(n, m) + 1, start: Math.min(n, m) - 1 };
  throw typeError(`Convolution mode must be 'full', 'same' or 'valid', got ${String(mode)}`, 'compute');
}

/** WGSL for direct 1-D convolution of `lines` signals of length n with one kernel of length m. */
export const convolve1dShader = /* wgsl */ `struct Conv { n: u32, m: u32, length: u32, start: u32, lines: u32 }
@group(0) @binding(0) var<storage, read> signal: array<f32>;
@group(0) @binding(1) var<storage, read> taps: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@group(0) @binding(3) var<uniform> conv: Conv;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (t >= conv.length * conv.lines) { return; }
  let line = t / conv.length;
  let k = t % conv.length + conv.start;
  let first = select(0u, k - (conv.m - 1u), k >= conv.m - 1u);
  let last = min(k, conv.n - 1u);
  var sum = 0.0;
  for (var j = first; j <= last; j++) { sum += signal[line * conv.n + j] * taps[k - j]; }
  out[t] = sum;
}`;

/** WGSL for direct 2-D convolution (zero fill) of `batch` images h x w with one kernel kh x kw. */
export const convolve2dShader = /* wgsl */ `struct Conv { h: u32, w: u32, kh: u32, kw: u32, oh: u32, ow: u32, y0: u32, x0: u32, batch: u32 }
@group(0) @binding(0) var<storage, read> image: array<f32>;
@group(0) @binding(1) var<storage, read> taps: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@group(0) @binding(3) var<uniform> conv: Conv;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (t >= conv.oh * conv.ow * conv.batch) { return; }
  let b = t / (conv.oh * conv.ow);
  let y = (t / conv.ow) % conv.oh + conv.y0;
  let x = t % conv.ow + conv.x0;
  var sum = 0.0;
  for (var i = 0u; i < conv.kh; i++) {
    if (y < i || y - i >= conv.h) { continue; }
    for (var j = 0u; j < conv.kw; j++) {
      if (x < j || x - j >= conv.w) { continue; }
      sum += image[(b * conv.h + y - i) * conv.w + x - j] * taps[i * conv.kw + j];
    }
  }
  out[t] = sum;
}`;

/**
 * 1-D convolution of `signal` (along its last axis, batched over the rest) with `kernel` (1-D), NumPy `convolve`
 * semantics, f32.
 * @example const smooth = convolve(series, gpu.array([0.25, 0.5, 0.25]), { mode: 'same' });
 */
export function convolve(signal: Operand, kernel: Operand, options: ConvolveOptions = {}): GpuArray {
  if (!(signal instanceof Operand) || !(kernel instanceof Operand))
    throw typeError('convolve takes two GpuArrays or Exprs', 'compute');
  if (kernel.ndim !== 1) throw rangeError('convolve takes a 1-D kernel; use convolve2d for images', 'compute');
  if (signal.ndim < 1) throw rangeError('convolve needs a signal of at least one dimension', 'compute');
  const ctx = signal.context;
  ctx.check();
  const n = signal.shape[signal.ndim - 1],
    m = kernel.size;
  if (n === 0 || m === 0) throw rangeError('convolve needs non-empty signal and kernel', 'compute');
  const mode = options.mode ?? 'full',
    { length, start } = window(n, m, mode),
    lines = signal.size / n,
    shape = [...signal.shape.slice(0, -1), length];
  const method = options.method ?? 'auto';
  // Convolution is commutative; with a kernel longer than the signal, 'valid' keeps the full-overlap part either way.
  if (method === 'fft' || (method === 'auto' && Math.min(n, m) > 64)) {
    let size = 1;
    while (size < n + m - 1) size *= 2;
    const padded = (x: Operand, len: number, count: number) => {
      const { array, owned } = contiguousF32(x);
      const out = ctx.zeros([count, size]);
      ctx.submit(
        [],
        Array.from(
          { length: count },
          (_, line) => [array.buffer, line * len * 4, out.buffer, line * size * 4, len * 4] as const,
        ),
      );
      if (owned) array.dispose();
      return out;
    };
    const s = padded(signal, n, lines),
      k = padded(kernel, m, 1);
    const S = fft(s),
      K = fft(k);
    const re = S.re.mul(K.re).sub(S.im.mul(K.im)).eval(),
      im = S.re.mul(K.im).add(S.im.mul(K.re)).eval();
    const back = ifft({ re: re as GpuArray<'f32'>, im: im as GpuArray<'f32'> });
    const out = back.re
      .slice(null, [start, start + length])
      .eval()
      .transfer(shape);
    for (const x of [s, k, S.re, S.im, K.re, K.im, re, im, back.re, back.im]) x.dispose();
    return out;
  }
  const a = contiguousF32(signal),
    v = contiguousF32(kernel),
    out = ctx.empty(shape, 'f32');
  ctx.submit([
    {
      program: ctx.program(convolve1dShader, undefined, 'convolve'),
      resources: { signal: a.array, taps: v.array, out, conv: new Uint32Array([n, m, length, start, lines, 0, 0, 0]) },
      workgroups: ctx.grid(Math.ceil((length * lines) / 256)),
    },
  ]);
  if (a.owned) a.array.dispose();
  if (v.owned) v.array.dispose();
  return out;
}

/** 1-D cross-correlation (NumPy `correlate`, default mode `'valid'`): convolution with the reversed kernel. */
export function correlate(signal: Operand, kernel: Operand, options: ConvolveOptions = {}): GpuArray {
  const k = kernel instanceof GpuArray ? kernel : kernel.eval();
  const out = convolve(signal, k.slice([null, null, -1]), { mode: 'valid', ...options });
  if (k !== kernel) k.dispose();
  return out;
}

/**
 * 2-D convolution of `image` (its last two axes, batched over the rest) with a 2-D `kernel`, zero-filled at the edges
 * (SciPy `convolve2d` with `boundary='fill'`), f32.
 * @example const blurred = convolve2d(image, gaussian5x5, { mode: 'same' });
 */
export function convolve2d(image: Operand, kernel: Operand, options: ConvolveOptions = {}): GpuArray {
  if (!(image instanceof Operand) || !(kernel instanceof Operand))
    throw typeError('convolve2d takes two GpuArrays or Exprs', 'compute');
  if (kernel.ndim !== 2 || image.ndim < 2)
    throw rangeError('convolve2d takes an image of at least 2 dimensions and a 2-D kernel', 'compute');
  const ctx: ComputeContext = image.context;
  ctx.check();
  const [h, w] = image.shape.slice(-2),
    [kh, kw] = kernel.shape;
  if (!h || !w || !kh || !kw) throw rangeError('convolve2d needs non-empty image and kernel', 'compute');
  const mode = options.mode ?? 'full',
    rows = window(h, kh, mode),
    cols = window(w, kw, mode),
    batch = image.size / (h * w),
    shape = [...image.shape.slice(0, -2), rows.length, cols.length],
    method = options.method ?? 'auto';
  if (method === 'fft' || (method === 'auto' && kh * kw > 225)) {
    const size = (len: number) => {
      let s = 1;
      while (s < len) s *= 2;
      return s;
    };
    const H = size(h + kh - 1),
      W = size(w + kw - 1);
    const pad = (x: Operand, count: number, xh: number, xw: number) => {
      const { array, owned } = contiguousF32(x);
      const out = ctx.zeros([count, H, W]);
      const copies: [GPUBuffer, number, GPUBuffer, number, number][] = [];
      for (let b = 0; b < count; b++)
        for (let y = 0; y < xh; y++)
          copies.push([array.buffer, (b * xh + y) * xw * 4, out.buffer, (b * H + y) * W * 4, xw * 4]);
      ctx.submit([], copies);
      if (owned) array.dispose();
      return out;
    };
    const I = pad(image, batch, h, w),
      K = pad(kernel, 1, kh, kw);
    const FI = fft2(I),
      FK = fft2(K);
    const re = FI.re.mul(FK.re).sub(FI.im.mul(FK.im)).eval() as GpuArray<'f32'>,
      im = FI.re.mul(FK.im).add(FI.im.mul(FK.re)).eval() as GpuArray<'f32'>;
    const back = ifft2({ re, im });
    const out = back.re
      .slice(null, [rows.start, rows.start + rows.length], [cols.start, cols.start + cols.length])
      .eval()
      .transfer(shape);
    for (const x of [I, K, FI.re, FI.im, FK.re, FK.im, re, im, back.re, back.im]) x.dispose();
    return out;
  }
  const a = contiguousF32(image),
    v = contiguousF32(kernel),
    out = ctx.empty(shape, 'f32'),
    count = rows.length * cols.length * batch;
  if (count > 0)
    ctx.submit([
      {
        program: ctx.program(convolve2dShader, undefined, 'convolve2d'),
        resources: {
          image: a.array,
          taps: v.array,
          out,
          conv: new Uint32Array([h, w, kh, kw, rows.length, cols.length, rows.start, cols.start, batch, 0, 0, 0]),
        },
        workgroups: ctx.grid(Math.ceil(count / 256)),
      },
    ]);
  if (a.owned) a.array.dispose();
  if (v.owned) v.array.dispose();
  return out;
}
