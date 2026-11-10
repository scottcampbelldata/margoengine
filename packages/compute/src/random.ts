// @margoengine/compute/random: reproducible random numbers on the GPU from the counter-based Philox4x32-10 generator
// (J. K. Salmon, M. A. Moraes, R. O. Dror and D. E. Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC11): every
// group of four outputs is a pure function of (counter, key), so any element can be computed independently and a
// seed gives the same stream on every device. Each draw advances the generator's counter past the blocks it used.
// Normals use the Box-Muller transform (G. E. P. Box and M. E. Muller, Ann. Math. Statist. 29(2), 1958).
import { rangeError, typeError } from '../../shared/errors.js';
import { preciseMathWgsl } from '../../shared/precise-math.js';
import { checkShape, type GpuArray } from './array.js';
import type { DType } from './dtype.js';
import type { ComputeContext } from './context.js';

/** Philox4x32 multipliers and Weyl key increments (Salmon et al. 2011, table 2). */
export const PHILOX = { M0: 0xd2511f53, M1: 0xcd9e8d57, W0: 0x9e3779b9, W1: 0xbb67ae85 } as const;

/** Philox4x32-10 on the CPU: the four 32-bit outputs for `counter` (4 words) and `key` (2 words). */
export function philox4x32(counter: readonly number[], key: readonly number[]): Uint32Array {
  let [c0, c1, c2, c3] = counter.map((v) => v >>> 0),
    [k0, k1] = key.map((v) => v >>> 0);
  for (let round = 0; round < 10; round++) {
    const p0 = BigInt(PHILOX.M0) * BigInt(c0),
      p1 = BigInt(PHILOX.M1) * BigInt(c2);
    const hi0 = Number(p0 >> 32n),
      lo0 = Number(p0 & 0xffffffffn),
      hi1 = Number(p1 >> 32n),
      lo1 = Number(p1 & 0xffffffffn);
    [c0, c1, c2, c3] = [(hi1 ^ c1 ^ k0) >>> 0, lo1, (hi0 ^ c3 ^ k1) >>> 0, lo0];
    k0 = (k0 + PHILOX.W0) >>> 0;
    k1 = (k1 + PHILOX.W1) >>> 0;
  }
  return new Uint32Array([c0, c1, c2, c3]);
}

// The 64-bit product of two u32 as (hi, lo), from 16-bit halves (WGSL has no 64-bit integers).
const wgslPhilox = /* wgsl */ `
fn mulhilo(a: u32, b: u32) -> vec2u {
  let a0 = a & 0xffffu; let a1 = a >> 16u;
  let b0 = b & 0xffffu; let b1 = b >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
  let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
  let lo = (mid << 16u) | (p00 & 0xffffu);
  return vec2u(hi, lo);
}
fn philox(counter: vec4u, key: vec2u) -> vec4u {
  var c = counter;
  var k = key;
  for (var iteration = 0u; iteration < 10u; iteration++) {
    let m0 = mulhilo(0xd2511f53u, c.x);
    let m1 = mulhilo(0xcd9e8d57u, c.z);
    c = vec4u(m1.x ^ c.y ^ k.x, m1.y, m0.x ^ c.w ^ k.y, m0.y);
    k = k + vec2u(0x9e3779b9u, 0xbb67ae85u);
  }
  return c;
}`;

/**
 * WGSL that fills `out` with one distribution: element i takes word i % 4 of the Philox block for counter
 * (offset + i / 4, offsetHigh, stream, 0). `kind` 0 raw u32, 1 uniform [low, high), 2 normal (mean, std),
 * 3 integers in [low, high) (the high word of word * range: D. Lemire, "Fast random integer generation in an interval",
 * ACM TOMACS 29(1), 2019, without the rejection step, so the bias is below range / 2^32).
 */
export function randomShader(dtype: DType): string {
  return /* wgsl */ `${dtype === 'f16' ? 'enable f16;\n' : ''}struct Draw { n: u32, offset: u32, offsetHigh: u32, kind: u32, key0: u32, key1: u32, stream: u32, range: u32, a: f32, b: f32, base: i32, pad: u32 }
@group(0) @binding(0) var<storage, read_write> out: array<${dtype}>;
@group(0) @binding(1) var<uniform> draw: Draw;
${wgslPhilox}
${preciseMathWgsl(['preciseSqrt', 'preciseLog', 'preciseSin', 'preciseCos'])}
fn unit(x: u32) -> f32 { return f32(x >> 8u) * 5.9604644775390625e-8; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= draw.n) { return; }
  let block = i / 4u;
  let low = draw.offset + block;
  let high = draw.offsetHigh + select(0u, 1u, low < draw.offset);
  let r = philox(vec4u(low, high, draw.stream, 0u), vec2u(draw.key0, draw.key1));
  let lane = i % 4u;
  let word = r[lane];
  if (draw.kind == 1u) {
    // The product hidden (pmHide), so no compiler fuses it with the sum (Mesa on an Intel UHD did): the same bits on
    // every device and on the CPU backend, which rounds the product and the sum apart.
    out[i] = ${dtype}(draw.a + pmHide((draw.b - draw.a) * unit(word)));
  } else if (draw.kind == 2u) {
    // Box-Muller on the lane pair (0,1) or (2,3): u1 in (0, 1] keeps log finite.
    let pair = lane & 2u;
    let u1 = f32((r[pair] >> 8u) + 1u) * 5.9604644775390625e-8;
    let u2 = unit(r[pair + 1u]);
    // The precise functions, so every GPU draws the same numbers as the CPU backend.
    let radius = preciseSqrt(-2.0 * preciseLog(u1));
    let angle = 6.283185307179586 * u2;
    let z = select(radius * preciseCos(angle), radius * preciseSin(angle), (lane & 1u) == 1u);
    out[i] = ${dtype}(draw.a + draw.b * z);
  } else if (draw.kind == 3u) {
    let m = mulhilo(word, draw.range);
    out[i] = ${dtype}(draw.base + bitcast<i32>(m.x));
  } else {
    out[i] = ${dtype === 'u32' ? 'word' : `${dtype}(word)`};
  }
}`;
}

/** Options for creating a generator. */
export interface RandomOptions {
  /** Seed (an integer up to 2^53). Default: one from `crypto.getRandomValues`. */
  readonly seed?: number;
  /** Independent stream number for the same seed (parallel workers). Default 0. */
  readonly stream?: number;
}

/**
 * A reproducible GPU random number generator (Philox4x32-10). The same seed and stream give the same numbers on every
 * device; each draw continues where the last stopped.
 * @example const rng = new Random(gpu, { seed: 42 }); const noise = rng.normal([1024, 1024]);
 */
export class Random {
  /** The seed. */
  readonly seed: number;
  /** The stream number. */
  readonly stream: number;
  readonly #ctx: ComputeContext;
  readonly #key: [number, number];
  #counter = 0n;

  constructor(ctx: ComputeContext, options: RandomOptions = {}) {
    this.#ctx = ctx;
    let seed = options.seed;
    if (seed === undefined) {
      const words = new Uint32Array(2);
      globalThis.crypto.getRandomValues(words);
      seed = words[0] + (words[1] & 0x1fffff) * 2 ** 32;
    }
    if (!Number.isSafeInteger(seed) || seed < 0)
      throw rangeError(`Random seed must be a whole number from 0 to 2^53, got ${seed}`, 'compute');
    const stream = options.stream ?? 0;
    if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff)
      throw rangeError(`Random stream must be a u32, got ${stream}`, 'compute');
    this.seed = seed;
    this.stream = stream;
    this.#key = [(seed % 2 ** 32) >>> 0, Math.floor(seed / 2 ** 32) >>> 0];
  }

  /** Blocks of four words drawn so far (the counter). */
  get counter(): bigint {
    return this.#counter;
  }

  #draw<T extends DType>(
    shape: number | readonly number[],
    dtype: T,
    kind: number,
    a = 0,
    b = 0,
    base = 0,
    range = 0,
  ): GpuArray<T> {
    const dims = checkShape(typeof shape === 'number' ? [shape] : shape),
      out = this.#ctx.empty(dims, dtype),
      n = out.size;
    if (n === 0) return out;
    const view = new DataView(new ArrayBuffer(48));
    [
      n,
      Number(this.#counter & 0xffffffffn),
      Number((this.#counter >> 32n) & 0xffffffffn),
      kind,
      this.#key[0],
      this.#key[1],
      this.stream,
      range,
    ].forEach((v, k) => view.setUint32(k * 4, v >>> 0, true));
    view.setFloat32(32, a, true);
    view.setFloat32(36, b, true);
    view.setInt32(40, base, true);
    this.#ctx.submit([
      {
        program: this.#ctx.program(randomShader(dtype), undefined, 'random'),
        resources: { out, draw: new Uint8Array(view.buffer) },
        workgroups: this.#ctx.grid(Math.ceil(n / 256)),
      },
    ]);
    this.#counter += BigInt(Math.ceil(n / 4));
    return out;
  }

  /** Raw 32-bit words. */
  bits(shape: number | readonly number[]): GpuArray<'u32'> {
    return this.#draw(shape, 'u32', 0);
  }

  /** Uniform floats in [low, high) (default [0, 1)), 24 bits of randomness each, f32. */
  uniform(
    shape: number | readonly number[],
    options: { readonly low?: number; readonly high?: number } = {},
  ): GpuArray<'f32'> {
    const low = options.low ?? 0,
      high = options.high ?? 1;
    if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low))
      throw rangeError(`uniform needs finite low < high, got ${low}, ${high}`, 'compute');
    return this.#draw(shape, 'f32', 1, low, high);
  }

  /** Normally distributed floats with `mean` (default 0) and `std` (default 1), f32. */
  normal(
    shape: number | readonly number[],
    options: { readonly mean?: number; readonly std?: number } = {},
  ): GpuArray<'f32'> {
    const mean = options.mean ?? 0,
      std = options.std ?? 1;
    if (!Number.isFinite(mean) || !(std >= 0))
      throw rangeError(`normal needs a finite mean and std >= 0, got ${mean}, ${std}`, 'compute');
    return this.#draw(shape, 'f32', 2, mean, std);
  }

  /** Integers in [low, high) (i32). The bias toward some values is below (high - low) / 2^32. */
  integers(low: number, high: number, shape: number | readonly number[]): GpuArray<'i32'> {
    if (
      !Number.isInteger(low) ||
      !Number.isInteger(high) ||
      high <= low ||
      high - low > 0xffffffff ||
      low < -(2 ** 31) ||
      high > 2 ** 31
    )
      throw rangeError(`integers needs whole numbers low < high within i32, got ${low}, ${high}`, 'compute');
    return this.#draw(shape, 'i32', 3, 0, 0, low, high - low);
  }

  /**
   * A random permutation of 0..n-1 (u32): the stable argsort of random 32-bit keys. Equal keys keep index order, so it
   * departs from uniform only when two keys tie, which happens with probability below n (n - 1) / 2^33.
   */
  permutation(n: number): GpuArray<'u32'> {
    if (!Number.isInteger(n) || n < 0) throw rangeError(`permutation n must be a whole number, got ${n}`, 'compute');
    const keys = this.bits(n),
      order = this.#ctx.argsort(keys);
    keys.dispose();
    return order;
  }

  /** `size` elements of `input` chosen uniformly with replacement (or without, via a permutation). */
  choice(input: GpuArray, size: number, options: { readonly replace?: boolean } = {}): GpuArray {
    if (!(input && typeof input === 'object' && 'storage' in input))
      throw typeError('choice takes a GpuArray', 'compute');
    if (!Number.isInteger(size) || size < 0)
      throw rangeError(`choice size must be a whole number, got ${size}`, 'compute');
    if (options.replace === false) {
      if (size > input.size)
        throw rangeError(`choice without replacement of ${size} from ${input.size} elements`, 'compute');
      const order = this.permutation(input.size),
        head = order.slice([0, size]),
        out = this.#ctx.take(input, head);
      order.dispose();
      return out;
    }
    const picks = this.integers(0, input.size, size),
      out = this.#ctx.take(input, picks);
    picks.dispose();
    return out;
  }
}
