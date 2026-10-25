// @margoengine/compute/fft: discrete Fourier transforms on the GPU. Complex data travels as separate real and imaginary
// f32 arrays ({ re, im }). Power-of-two lengths use the radix-2 Stockham autosort formulation (each pass reads
// x[j] and x[j + n/2] and writes the butterfly to 2j - (j mod l) and that plus l, so no bit reversal is needed), as
// described by N. K. Govindaraju, B. Lloyd, Y. Dotsenko, B. Smith and J. Manferdelli, "High performance discrete
// Fourier transforms on graphics processors", SC08, and C. Van Loan, "Computational Frameworks for the Fast Fourier
// Transform", SIAM 1992. Other lengths use Bluestein's chirp-z algorithm (L. I. Bluestein, "A linear filtering approach
// to the computation of the discrete Fourier transform", IEEE Trans. Audio Electroacoustics 18(4), 1970): the DFT
// becomes a convolution with a chirp, done with power-of-two transforms. Normalisation follows NumPy's default:
// forward unscaled, inverse scaled by 1/n.
import { rangeError, typeError } from '../../shared/errors.js';
import { GpuArray, axisOf } from './array.js';
import { Operand } from './expr.js';
import type { ComputeContext, Pass } from './context.js';

/** A complex array as separate real and imaginary parts (f32, same shape). */
export interface Complex {
  readonly re: GpuArray<'f32'>;
  readonly im: GpuArray<'f32'>;
}

/** Options for transforms. */
export interface FFTOptions {
  /** Axis to transform along. Default the last. */
  readonly axis?: number;
}

/** WGSL for one radix-2 Stockham pass over `lines` lines of length `n`; `l` is the current sub-transform length. */
export const stockhamShader = /* wgsl */ `struct Pass { n: u32, l: u32, lines: u32, inverse: u32 }
@group(0) @binding(0) var<storage, read> reIn: array<f32>;
@group(0) @binding(1) var<storage, read> imIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> reOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> imOut: array<f32>;
@group(0) @binding(4) var<uniform> pass_: Pass;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = (wid.x + wid.y * nwg.x) * 256u + lid;
  let half = pass_.n / 2u;
  if (t >= half * pass_.lines) { return; }
  let line = t / half;
  let j = t % half;
  let base = line * pass_.n;
  let k = j % pass_.l;
  // Twiddle exp(-+ 2 pi i k / (2l)); k / (2l) is exact in f32 for power-of-two l.
  var angle = -6.283185307179586 * f32(k) / f32(2u * pass_.l);
  if (pass_.inverse == 1u) { angle = -angle; }
  let w = vec2f(cos(angle), sin(angle));
  let a = vec2f(reIn[base + j], imIn[base + j]);
  let b0 = vec2f(reIn[base + j + half], imIn[base + j + half]);
  let b = vec2f(w.x * b0.x - w.y * b0.y, w.x * b0.y + w.y * b0.x);
  let dest = base + 2u * j - k;
  reOut[dest] = a.x + b.x;
  imOut[dest] = a.y + b.y;
  reOut[dest + pass_.l] = a.x - b.x;
  imOut[dest + pass_.l] = a.y - b.y;
}`;

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

// Power-of-two transform of `lines` contiguous lines of length n; returns new arrays.
function pow2(ctx: ComputeContext, re: GpuArray, im: GpuArray, n: number, lines: number, inverse: boolean): Complex {
  let aRe = re,
    aIm = im;
  const owned: GpuArray[] = [];
  const program = ctx.program(stockhamShader, undefined, 'fft.stockham'),
    passes: Pass[] = [];
  const size = n * lines;
  const bRe = ctx.empty([size], 'f32'),
    bIm = ctx.empty([size], 'f32');
  const cRe = n > 2 ? ctx.empty([size], 'f32') : bRe,
    cIm = n > 2 ? ctx.empty([size], 'f32') : bIm;
  if (n === 1) {
    ctx.submit(
      [],
      [
        [re.buffer, re.offset * 4, bRe.buffer, 0, size * 4],
        [im.buffer, im.offset * 4, bIm.buffer, 0, size * 4],
      ],
    );
    return { re: bRe as GpuArray<'f32'>, im: bIm as GpuArray<'f32'> };
  }
  let target = 0;
  for (let l = 1; l < n; l *= 2) {
    const [outRe, outIm] = target === 0 ? [bRe, bIm] : [cRe, cIm];
    passes.push({
      program,
      resources: {
        reIn: aRe,
        imIn: aIm,
        reOut: outRe,
        imOut: outIm,
        pass_: new Uint32Array([n, l, lines, inverse ? 1 : 0]),
      },
      workgroups: ctx.grid(Math.ceil(size / 2 / 256)),
    });
    aRe = outRe;
    aIm = outIm;
    target ^= 1;
  }
  ctx.submit(passes);
  // The result sits in the last written pair; free the other.
  if (n > 2) for (const x of aRe === bRe ? [cRe, cIm] : [bRe, bIm]) owned.push(x);
  for (const x of owned) x.dispose();
  return { re: aRe as GpuArray<'f32'>, im: aIm as GpuArray<'f32'> };
}

// Complex multiply (a * b) as lazy expressions.
const cmul = (aRe: Operand, aIm: Operand, bRe: Operand, bIm: Operand) => ({
  re: aRe.mul(bRe).sub(aIm.mul(bIm)),
  im: aRe.mul(bIm).add(aIm.mul(bRe)),
});

// Any-length transform of contiguous lines through Bluestein's chirp-z.
function bluestein(
  ctx: ComputeContext,
  re: GpuArray,
  im: GpuArray,
  n: number,
  lines: number,
  inverse: boolean,
): Complex {
  let m = 1;
  while (m < 2 * n - 1) m *= 2;
  // Chirp w_k = exp(-+ i pi k^2 / n), computed in double precision with k^2 reduced mod 2n.
  const sign = inverse ? 1 : -1,
    wRe = new Float32Array(n),
    wIm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const angle = (sign * Math.PI * ((k * k) % (2 * n))) / n;
    wRe[k] = Math.cos(angle);
    wIm[k] = Math.sin(angle);
  }
  // b_k = conj(w_k) for |k| < n, wrapped to length m; its transform is shared by every line.
  const bRe = new Float32Array(m),
    bIm = new Float32Array(m);
  for (let k = 0; k < n; k++) {
    bRe[k] = wRe[k];
    bIm[k] = -wIm[k];
    if (k) {
      bRe[m - k] = wRe[k];
      bIm[m - k] = -wIm[k];
    }
  }
  const chirpRe = ctx.array(wRe, { shape: [1, n] }),
    chirpIm = ctx.array(wIm, { shape: [1, n] });
  const kernelRe = ctx.array(bRe),
    kernelIm = ctx.array(bIm);
  const kernel = pow2(ctx, kernelRe, kernelIm, m, 1, false);
  // a = x * w, zero-padded to m per line.
  const lineRe = re.reshape(lines, n),
    lineIm = im.reshape(lines, n);
  const a = cmul(lineRe, lineIm, chirpRe, chirpIm);
  const padRe = ctx.zeros([lines, m]),
    padIm = ctx.zeros([lines, m]);
  const aRe = a.re.eval(),
    aIm = a.im.eval();
  const copies: [GPUBuffer, number, GPUBuffer, number, number][] = [];
  for (let line = 0; line < lines; line++) {
    copies.push([aRe.buffer, line * n * 4, padRe.buffer, line * m * 4, n * 4]);
    copies.push([aIm.buffer, line * n * 4, padIm.buffer, line * m * 4, n * 4]);
  }
  ctx.submit([], copies);
  const A = pow2(ctx, padRe, padIm, m, lines, false);
  const kRe = kernel.re.reshape(1, m),
    kIm = kernel.im.reshape(1, m);
  const prod = cmul(A.re.reshape(lines, m), A.im.reshape(lines, m), kRe, kIm);
  const pRe = prod.re.eval(),
    pIm = prod.im.eval();
  const conv = pow2(ctx, pRe, pIm, m, lines, true);
  // X_k = w_k * conv_k / m (the inverse transform above is unscaled).
  const cRe = conv.re.reshape(lines, m).slice(null, [0, n]),
    cIm = conv.im.reshape(lines, m).slice(null, [0, n]);
  const out = cmul(cRe, cIm, chirpRe, chirpIm);
  const result = {
    re: out.re
      .mul(1 / m)
      .eval()
      .transfer([lines * n]) as GpuArray<'f32'>,
    im: out.im
      .mul(1 / m)
      .eval()
      .transfer([lines * n]) as GpuArray<'f32'>,
  };
  for (const x of [
    chirpRe,
    chirpIm,
    kernelRe,
    kernelIm,
    kernel.re,
    kernel.im,
    padRe,
    padIm,
    aRe,
    aIm,
    A.re,
    A.im,
    pRe,
    pIm,
    conv.re,
    conv.im,
  ])
    x.dispose();
  return result;
}

/** Transforms along `axis` of complex input given as parts (im may be absent for real input). */
function transform(input: Operand | Complex, options: FFTOptions, inverse: boolean): Complex {
  const re0 = input instanceof Operand ? input : input.re,
    im0 = input instanceof Operand ? undefined : input.im;
  if (!(re0 instanceof Operand)) throw typeError('fft takes a real array or { re, im } arrays', 'compute');
  if (im0 && (im0.ndim !== re0.ndim || im0.shape.some((d, k) => d !== re0.shape[k])))
    throw rangeError('fft re and im must have one shape', 'compute');
  const ctx = re0.context;
  ctx.check();
  if (re0.ndim === 0) throw rangeError('fft needs at least one dimension', 'compute');
  const axis = axisOf(options.axis ?? -1, re0.ndim),
    n = re0.shape[axis],
    shape = re0.shape;
  // Move the axis last and make the lines contiguous.
  const order = [...shape.keys()].filter((k) => k !== axis).concat(axis),
    back = order.map((_, k) => order.indexOf(k));
  const toLines = (x: Operand) => {
    const arr = x instanceof GpuArray ? x : x.eval();
    const lines = arr
      .transpose(...order)
      .astype('f32')
      .eval();
    if (arr !== x) arr.dispose();
    return lines;
  };
  const re = toLines(re0),
    im = im0 ? toLines(im0) : ctx.zeros(re.shape);
  const lines = n ? re.size / n : 0;
  let result: Complex;
  if (re.size === 0)
    result = { re: ctx.zeros(re.shape) as GpuArray<'f32'>, im: ctx.zeros(re.shape) as GpuArray<'f32'> };
  else if (isPow2(n)) result = pow2(ctx, re.reshape(re.size), im.reshape(im.size), n, lines, inverse);
  else result = bluestein(ctx, re, im, n, lines, inverse);
  re.dispose();
  im.dispose();
  const linesShape = order.map((k) => shape[k]);
  // Back to the input's axis order (a strided read), scaled by 1/n for the inverse, in one pass.
  const finish = (x: GpuArray<'f32'>) => {
    const moved = x.reshape(...linesShape).transpose(...back);
    const out = (inverse ? moved.mul(1 / n) : moved).eval() as GpuArray<'f32'>;
    x.dispose();
    return out;
  };
  const outRe = finish(result.re),
    outIm = finish(result.im);
  return { re: outRe, im: outIm };
}

/**
 * Forward discrete Fourier transform along `axis` (default the last), of a real array or `{ re, im }`. Any length.
 * @example const { re, im } = fft(signal); const power = re.square().add(im.square());
 */
export function fft(input: Operand | Complex, options: FFTOptions = {}): Complex {
  return transform(input, options, false);
}

/** Inverse transform along `axis`, scaled by 1/n (NumPy's default), so `ifft(fft(x)).re` is x. */
export function ifft(input: Operand | Complex, options: FFTOptions = {}): Complex {
  return transform(input, options, true);
}

/** Two-dimensional transform over the last two axes. */
export function fft2(input: Operand | Complex): Complex {
  const first = fft(input, { axis: -1 }),
    second = fft(first, { axis: -2 });
  first.re.dispose();
  first.im.dispose();
  return second;
}

/** Inverse two-dimensional transform over the last two axes. */
export function ifft2(input: Operand | Complex): Complex {
  const first = ifft(input, { axis: -1 }),
    second = ifft(first, { axis: -2 });
  first.re.dispose();
  first.im.dispose();
  return second;
}

/** Sample frequencies of an n-point transform with sample spacing `d` (NumPy `fftfreq`), f32. */
export function fftfreq(ctx: ComputeContext, n: number, d = 1): GpuArray<'f32'> {
  if (!Number.isInteger(n) || n < 1)
    throw rangeError(`fftfreq n must be a whole number of at least 1, got ${n}`, 'compute');
  const k = ctx.arange(0, n, 1, 'i32');
  // k for k < ceil(n/2), else k - n, all divided by n * d.
  const f = ctx
    .where(k.lt(Math.ceil(n / 2)), k, k.sub(n))
    .astype('f32')
    .mul(1 / (n * d))
    .eval() as GpuArray<'f32'>;
  k.dispose();
  return f;
}
